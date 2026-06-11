/**
 * PgKnowledgeTurnStore — Postgres implementation of IKnowledgeTurnStore.
 *
 * Wraps the `knowledge_turns` table (created by migration 0004_knowledge_turns.sql).
 * Uses `tsquery` + `ts_rank_cd` against the generated `tsv` tsvector column for
 * full-text search. All async — returns Promises instead of synchronous values.
 *
 * Mirrors SqliteKnowledgeTurnStore (src/storage/sqlite-knowledge-turn-store.ts),
 * swapping:
 *   - FTS5 MATCH   → tsquery @@ tsv
 *   - -bm25()      → ts_rank_cd() with application-side score normalization
 *   - Sync DB API  → async pg Pool queries
 *
 * No module-level caches; all state is instance-scoped (D2 constraint).
 *
 * Spec: 2026-05-01-tirqdp-community-port-design.md
 * Ticket: TIRQDP-1.3
 */

import { randomUUID } from "node:crypto";
import type { PgPool } from "./pg-types.js";
import type {
  IKnowledgeTurnStore,
  KnowledgeTurnInput,
  KnowledgeTurnRow,
  KnowledgeTurnHit,
  KnowledgeTurnSearchOptions,
} from "../interfaces/knowledge-turn-store.js";
import type { EmbeddingProvider } from "../../extensions/vector-search/embedding-provider.js";
import { encodeEmbeddingFor } from "../sqlite-knowledge-store.js";
import { CONFIG } from "../../config.js";

// ── tsquery sanitizer ────────────────────────────────────────────────────────

/**
 * Reduce a free-text query to plainto_tsquery-safe tokens, OR-joined with
 * the Postgres `|` operator.
 *
 * `plainto_tsquery` already handles most tokenization safely, but building
 * an OR query manually from individual tokens:
 *   1. Prevents implicit-AND behaviour (a document with "token" but not
 *      "authentication" would still rank for "authentication token").
 *   2. Mirrors the SQLite backend's `sanitizeFtsQuery` OR-join so that
 *      both backends return the same set of matching documents.
 *
 * We use `to_tsquery('english', ...)` rather than `plainto_tsquery` because
 * we want explicit OR (`|`). Each token is lexed via Postgres's tsquery
 * machinery via the `:*` prefix-match operator so stemming applies.
 *
 * Returns null if no usable tokens remain (caller should return [] early).
 */
function sanitizeTsQuery(raw: string): string | null {
  const tokens = raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 2);
  if (tokens.length === 0) return null;
  // Use plainto_tsquery per token to let Postgres handle stemming/stopwords,
  // then join with OR. Each token is wrapped in plainto_tsquery so we never
  // produce syntax errors from special characters.
  return tokens.join(" | ");
}

// ── row mapper ────────────────────────────────────────────────────────────────

function rowToKnowledgeTurn(row: Record<string, unknown>): KnowledgeTurnRow {
  return {
    turnId:       row.turn_id as string,
    sessionId:    row.session_id as string,
    project:      (row.project as string | null) ?? null,
    userId:       (row.user_id as string | null) ?? null,
    speaker:      row.speaker as string,
    content:      row.content as string,
    messageIndex: row.message_index as number,
    // Postgres returns bigint as string; coerce to number (epoch ms fits in JS float)
    createdAt:    Number(row.created_at),
  };
}

// ── store ─────────────────────────────────────────────────────────────────────

/**
 * Async Postgres implementation of IKnowledgeTurnStore.
 *
 * IKnowledgeTurnStore now uses Promise<T> return types (TIRQDP async-ify
 * refactor), so this class can safely claim `implements IKnowledgeTurnStore`.
 * All methods were already async — this is a type-system-only change.
 */
export class PgKnowledgeTurnStore implements IKnowledgeTurnStore {
  // No module-level caches (D2). All state scoped to this instance.
  // embedder is mutable (not readonly) so initEmbedder can late-inject via setEmbedder().
  private embedder: EmbeddingProvider | null;

  /**
   * Pending embed promises from fire-and-forget insert() calls.
   * deleteBySessionId() drains this set before issuing the DELETE so that
   * in-flight embed INSERTs cannot violate the knowledge_turn_embeddings FK.
   * (T3 fix — ticket #29)
   */
  private pendingInsertEmbeds: Set<Promise<void>> = new Set();

  constructor(private readonly pool: PgPool, embedder?: EmbeddingProvider | null) {
    this.embedder = embedder ?? null;
  }

  /** Late-inject an embedder after construction (used by initEmbedder PG branch). */
  setEmbedder(embedder: EmbeddingProvider | null): void {
    this.embedder = embedder;
  }

  // ── upsertTurnEmbedding ─────────────────────────────────────────────────────

  private async upsertTurnEmbedding(
    turnId: string,
    embedding: Buffer,
    model: string,
    format: string
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO knowledge_turn_embeddings (turn_id, embedding, model, format, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (turn_id) DO UPDATE
         SET embedding = $2, model = $3, format = $4, created_at = $5`,
      [turnId, embedding, model, format, Date.now()]
    );
  }

  /**
   * Embed a set of (turnId, content) pairs and upsert. Never throws.
   * Filters out empty/whitespace-only content before calling embedBatch
   * (Gemini returns 400 for empty content).
   */
  private async embedTurns(ids: string[], contents: string[]): Promise<void> {
    if (!this.embedder || ids.length === 0) return;
    try {
      const filteredIds: string[] = [];
      const filteredContents: string[] = [];
      for (let i = 0; i < ids.length; i++) {
        if (contents[i].trim().length > 0) {
          filteredIds.push(ids[i]);
          filteredContents.push(contents[i]);
        }
      }
      if (filteredIds.length === 0) return;

      const vectors = await this.embedder.embedBatch(
        filteredContents,
        CONFIG.search.denseTurnLane.docTaskType
      );
      const modelName = this.embedder.modelName;
      const supportsQuantization = this.embedder.supportsQuantization;
      for (let i = 0; i < vectors.length; i++) {
        const { buf, format } = encodeEmbeddingFor(vectors[i], supportsQuantization);
        await this.upsertTurnEmbedding(filteredIds[i], buf, modelName, format);
      }
    } catch (err) {
      console.error(`[strata] PgKnowledgeTurnStore: failed to embed ${ids.length} turns:`, err);
    }
  }

  // ── insert ──────────────────────────────────────────────────────────────────

  async insert(turn: KnowledgeTurnInput): Promise<string> {
    const turnId = randomUUID();
    await this.pool.query(
      `INSERT INTO knowledge_turns
         (turn_id, session_id, project, user_id, speaker, content, message_index, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        turnId,
        turn.sessionId,
        turn.project ?? null,
        turn.userId ?? null,
        turn.speaker,
        turn.content,
        turn.messageIndex,
        turn.createdAt ?? Date.now(),
      ],
    );
    if (this.embedder) {
      // Track the embed promise so deleteBySessionId() can await it before deleting,
      // preventing FK violations on knowledge_turn_embeddings (T3 fix — ticket #29).
      const embedPromise: Promise<void> = this.embedTurns([turnId], [turn.content]).finally(() => {
        this.pendingInsertEmbeds.delete(embedPromise);
      });
      this.pendingInsertEmbeds.add(embedPromise);
    }
    return turnId;
  }

  // ── bulkInsert ───────────────────────────────────────────────────────────────

  async bulkInsert(turns: KnowledgeTurnInput[]): Promise<string[]> {
    if (turns.length === 0) return [];

    const ids: string[] = [];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const turn of turns) {
        const turnId = randomUUID();
        await client.query(
          `INSERT INTO knowledge_turns
             (turn_id, session_id, project, user_id, speaker, content, message_index, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            turnId,
            turn.sessionId,
            turn.project ?? null,
            turn.userId ?? null,
            turn.speaker,
            turn.content,
            turn.messageIndex,
            turn.createdAt ?? Date.now(),
          ],
        );
        ids.push(turnId);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    if (this.embedder && turns.length > 0) {
      await this.embedTurns(ids, turns.map(t => t.content));
    }
    return ids;
  }

  // ── searchByQuery ────────────────────────────────────────────────────────────

  /**
   * Full-text search using `ts_rank_cd` against the generated `tsv` column.
   *
   * Score normalization:
   *   `ts_rank_cd` returns values in the range [0, 1] natively (it is
   *   already a coverage-density ratio, not a raw term frequency sum like
   *   SQLite's BM25). The SQLite backend negates BM25's negative raw values
   *   to produce "higher = better" in [0, ∞); SQLite scores are NOT bounded
   *   at 1. For RRF fusion (TIRQDP-1.4) both backends only need a consistent
   *   direction (higher = more relevant) — the absolute scale doesn't matter
   *   because RRF uses rank position, not raw score magnitude. We therefore
   *   return `ts_rank_cd` unchanged: it is already non-negative and higher =
   *   more relevant, which matches the contract in KnowledgeTurnHit.score.
   *
   *   The [0,1] bound is documented here so downstream callers that want to
   *   clamp to a shared range can do so, but no clamping is needed for RRF.
   *
   * user_id scoping:
   *   - userId is a string  → WHERE user_id = $n
   *   - userId is null      → WHERE user_id IS NULL
   *   - userId is undefined → no user_id filter (all users)
   */
  async searchByQuery(
    query: string,
    opts: KnowledgeTurnSearchOptions,
  ): Promise<KnowledgeTurnHit[]> {
    if (!query || query.trim().length === 0) return [];

    const sanitized = sanitizeTsQuery(query);
    if (sanitized === null) return [];

    // Build parameterized WHERE clause dynamically
    const conditions: string[] = ["tsv @@ to_tsquery('english', $1)"];
    const params: unknown[] = [sanitized];
    let paramIdx = 2;

    if (opts.userId !== undefined) {
      if (opts.userId === null) {
        conditions.push("user_id IS NULL");
      } else {
        conditions.push(`user_id = $${paramIdx++}`);
        params.push(opts.userId);
      }
    }

    if (opts.project !== undefined && opts.project !== null) {
      conditions.push(`project = $${paramIdx++}`);
      params.push(opts.project);
    }

    params.push(opts.limit);
    const limitIdx = paramIdx++;

    const sql = `
      SELECT
        turn_id, session_id, project, user_id, speaker, content, message_index, created_at,
        ts_rank_cd(tsv, to_tsquery('english', $1)) AS score
      FROM knowledge_turns
      WHERE ${conditions.join(" AND ")}
      ORDER BY score DESC
      LIMIT $${limitIdx}
    `;

    const { rows } = await this.pool.query(sql, params);
    return rows.map((r: Record<string, unknown>) => ({
      row: rowToKnowledgeTurn(r),
      // ts_rank_cd already returns float in [0,1]; cast from pg numeric string
      score: parseFloat(r.score as string),
    }));
  }

  // ── getBySessionId ───────────────────────────────────────────────────────────

  async getBySessionId(sessionId: string): Promise<KnowledgeTurnRow[]> {
    const { rows } = await this.pool.query(
      `SELECT turn_id, session_id, project, user_id, speaker, content, message_index, created_at
         FROM knowledge_turns
        WHERE session_id = $1
        ORDER BY message_index ASC`,
      [sessionId],
    );
    return rows.map(rowToKnowledgeTurn);
  }

  // ── getByIds ─────────────────────────────────────────────────────────────────

  async getByIds(turnIds: string[]): Promise<KnowledgeTurnRow[]> {
    if (turnIds.length === 0) return [];
    // PG parameterized IN clause via $1, $2, ... $N
    const placeholders = turnIds.map((_, i) => `$${i + 1}`).join(", ");
    const { rows } = await this.pool.query(
      `SELECT turn_id, session_id, project, user_id, speaker, content, message_index, created_at
         FROM knowledge_turns
        WHERE turn_id IN (${placeholders})`,
      turnIds,
    );
    return rows.map(rowToKnowledgeTurn);
  }

  // ── deleteBySessionId ────────────────────────────────────────────────────────

  async deleteBySessionId(sessionId: string): Promise<void> {
    // T3 fix (ticket #29): drain any in-flight embed promises from insert() before
    // issuing the DELETE. Without this, a fire-and-forget embed from a prior insert()
    // can target a knowledge_turn_embeddings row whose FK parent (knowledge_turns) is
    // already deleted → PG error 23503. The embed already catches and logs errors
    // silently, but draining here guarantees the correct ordering:
    //   embed INSERT completes → ON DELETE CASCADE handles cleanup → parent DELETE fires
    // This matches the latency semantics of bulkInsert (which already awaits embedTurns).
    if (this.pendingInsertEmbeds.size > 0) {
      await Promise.allSettled([...this.pendingInsertEmbeds]);
    }
    await this.pool.query(
      "DELETE FROM knowledge_turns WHERE session_id = $1",
      [sessionId],
    );
    // No FTS trigger cleanup needed: the generated tsvector column is stored
    // inline in knowledge_turns and is removed automatically with the row.
  }

  // ── count ────────────────────────────────────────────────────────────────────

  async count(): Promise<number> {
    const { rows } = await this.pool.query(
      "SELECT COUNT(*)::integer AS cnt FROM knowledge_turns",
    );
    return rows[0].cnt as number;
  }
}
