/**
 * D1KnowledgeTurnStore — Cloudflare D1 implementation of IKnowledgeTurnStore.
 *
 * Wraps knowledge_turns + knowledge_turn_embeddings (migration 0006).
 * Uses FTS5 MATCH + BM25 for searchByQuery. Embedding is fire-and-forget.
 *
 * D1 constraints:
 *   - No node:crypto — uses globalThis.crypto.randomUUID() with manual fallback
 *   - No transactions — bulkInsert chunks at ≤50 turns per db.batch() call
 *     (each INSERT fires knowledge_turns_ai trigger: 50 turns × 2 stmts = 100, the D1 limit)
 *   - Embedder is late-injected via setEmbedder() (IEmbeddableTurnStore contract)
 *
 * Template: src/storage/pg/pg-knowledge-turn-store.ts (PR2)
 * Spec: 2026-06-04-dtl-pr3-d1-plan.md
 * PR: feat/dtl-pr3-d1
 */

import type { D1Database } from "./d1-types.js";
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

// ── UUID ─────────────────────────────────────────────────────────────────────

/**
 * Generate a UUID v4. Uses crypto.randomUUID() when available (Workers runtime),
 * otherwise falls back to a manual implementation.
 * Mirrors D1DocumentStore.generateUUID() — no node:crypto in Workers.
 */
function generateUUID(): string {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return globalThis.crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ── FTS5 sanitizer ────────────────────────────────────────────────────────────

/**
 * Sanitize a query string for FTS5 MATCH syntax.
 * Duplicated from D1KnowledgeStore to avoid cross-adapter imports.
 */
function sanitizeFtsQuery(query: string): string {
  const cleaned = query
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  const tokens = cleaned.split(" ").filter(Boolean);
  return tokens.join(" ");
}

// ── Row mapper ────────────────────────────────────────────────────────────────

interface D1TurnRow {
  turn_id: string;
  session_id: string;
  project: string | null;
  user_id: string | null;
  speaker: string;
  content: string;
  message_index: number;
  created_at: number;
}

function rowToKnowledgeTurn(row: D1TurnRow): KnowledgeTurnRow {
  return {
    turnId: row.turn_id,
    sessionId: row.session_id,
    project: row.project ?? null,
    userId: row.user_id ?? null,
    speaker: row.speaker,
    content: row.content,
    messageIndex: row.message_index,
    createdAt: Number(row.created_at),
  };
}

// ── D1KnowledgeTurnStore ─────────────────────────────────────────────────────

/**
 * D1-backed turn store. Implements IKnowledgeTurnStore + setEmbedder()
 * (structural IEmbeddableTurnStore compatibility for the generic server
 * wiring in server.ts PR2).
 *
 * All methods are async (D1 API requirement). bulkInsert chunks at ≤50 turns
 * per db.batch() to stay within the 100-statement D1 batch limit
 * (each INSERT fires knowledge_turns_ai FTS trigger = 2 statements per turn).
 */
export class D1KnowledgeTurnStore implements IKnowledgeTurnStore {
  // embedder is mutable so initEmbedder can late-inject via setEmbedder()
  private embedder: EmbeddingProvider | null;

  constructor(private db: D1Database, embedder?: EmbeddingProvider | null) {
    this.embedder = embedder ?? null;
  }

  /** Late-inject an embedder after construction (IEmbeddableTurnStore contract). */
  setEmbedder(embedder: EmbeddingProvider | null): void {
    this.embedder = embedder;
  }

  // ── upsertTurnEmbedding ───────────────────────────────────────────────────

  private async upsertTurnEmbedding(
    turnId: string,
    embedding: ArrayBuffer,
    model: string,
    format: string
  ): Promise<void> {
    await this.db
      .prepare(
        "INSERT OR REPLACE INTO knowledge_turn_embeddings (turn_id, embedding, model, created_at, format) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(turnId, embedding, model, Date.now(), format)
      .run();
  }

  /**
   * Embed a set of (turnId, content) pairs and upsert. Never throws.
   * Filters out empty/whitespace-only content before calling embedBatch
   * (Gemini returns 400 for empty content).
   *
   * Uses encodeEmbeddingFor for quantization-aware encoding. D1 BLOB
   * columns require ArrayBuffer (not Buffer), so we convert via
   * buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength).
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
        const { buf, format } = encodeEmbeddingFor(
          vectors[i],
          supportsQuantization
        );
        // D1 BLOB columns require ArrayBuffer, not Buffer.
        const ab = buf.buffer.slice(
          buf.byteOffset,
          buf.byteOffset + buf.byteLength
        ) as ArrayBuffer;
        await this.upsertTurnEmbedding(filteredIds[i], ab, modelName, format);
      }
    } catch (err) {
      console.error(
        `[strata] D1KnowledgeTurnStore: failed to embed ${ids.length} turns:`,
        err
      );
    }
  }

  // ── insert ────────────────────────────────────────────────────────────────

  async insert(turn: KnowledgeTurnInput): Promise<string> {
    const turnId = generateUUID();
    await this.db
      .prepare(
        `INSERT INTO knowledge_turns
           (turn_id, session_id, project, user_id, speaker, content, message_index, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        turnId,
        turn.sessionId,
        turn.project ?? null,
        turn.userId ?? null,
        turn.speaker,
        turn.content,
        turn.messageIndex,
        turn.createdAt ?? Date.now()
      )
      .run();

    if (this.embedder) {
      // Fire-and-forget — embedTurns never throws
      this.embedTurns([turnId], [turn.content]).catch(() => {});
    }
    return turnId;
  }

  // ── bulkInsert ─────────────────────────────────────────────────────────────

  /**
   * Insert multiple turns. Chunks at ≤50 turns per db.batch() call to stay
   * within D1's 100-statement batch limit (each INSERT fires knowledge_turns_ai,
   * so 50 turns × 2 stmts = 100 — exactly at the limit).
   *
   * Embedding is fired after all inserts succeed (same semantics as PG impl).
   */
  async bulkInsert(turns: KnowledgeTurnInput[]): Promise<string[]> {
    if (turns.length === 0) return [];

    const ids: string[] = turns.map(() => generateUUID());
    const CHUNK_SIZE = 50;

    for (let start = 0; start < turns.length; start += CHUNK_SIZE) {
      const chunk = turns.slice(start, start + CHUNK_SIZE);
      const chunkIds = ids.slice(start, start + CHUNK_SIZE);

      const statements = chunk.map((turn, i) =>
        this.db
          .prepare(
            `INSERT INTO knowledge_turns
               (turn_id, session_id, project, user_id, speaker, content, message_index, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            chunkIds[i],
            turn.sessionId,
            turn.project ?? null,
            turn.userId ?? null,
            turn.speaker,
            turn.content,
            turn.messageIndex,
            turn.createdAt ?? Date.now()
          )
      );

      await this.db.batch(statements);
    }

    if (this.embedder) {
      await this.embedTurns(ids, turns.map((t) => t.content));
    }
    return ids;
  }

  // ── searchByQuery ──────────────────────────────────────────────────────────

  /**
   * Full-text search using FTS5 MATCH + BM25.
   *
   * Score convention: FTS5 bm25() returns negative values; negate for
   * "higher = more relevant" (mirrors SqliteKnowledgeTurnStore).
   *
   * Fallback: if the AND query returns zero results, retry with OR
   * (same pattern as D1KnowledgeStore.search).
   *
   * userId scoping:
   *   - userId is a string  → WHERE user_id = ?
   *   - userId is null      → WHERE user_id IS NULL
   *   - userId is undefined → no user_id filter
   */
  async searchByQuery(
    query: string,
    opts: KnowledgeTurnSearchOptions
  ): Promise<KnowledgeTurnHit[]> {
    if (!query || query.trim().length === 0) return [];

    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];

    const results = await this._execFtsQuery(sanitized, opts);
    if (results.length > 0) return results;

    // OR-fallback: join tokens with OR
    const tokens = sanitized.split(" ").filter(Boolean);
    if (tokens.length <= 1) return results;
    const orQuery = tokens.join(" OR ");
    return this._execFtsQuery(orQuery, opts);
  }

  private async _execFtsQuery(
    ftsQuery: string,
    opts: KnowledgeTurnSearchOptions
  ): Promise<KnowledgeTurnHit[]> {
    const conditions: string[] = ["knowledge_turns_fts MATCH ?"];
    const params: unknown[] = [ftsQuery];

    if (opts.userId !== undefined) {
      if (opts.userId === null) {
        conditions.push("t.user_id IS NULL");
      } else {
        conditions.push("t.user_id = ?");
        params.push(opts.userId);
      }
    }

    if (opts.project !== undefined && opts.project !== null) {
      conditions.push("t.project = ?");
      params.push(opts.project);
    }

    params.push(opts.limit);

    // nosemgrep: sql-injection-template-literal -- conditions built from code-controlled clauses; user values bound via ?
    const sql = `
      SELECT
        t.turn_id, t.session_id, t.project, t.user_id,
        t.speaker, t.content, t.message_index, t.created_at,
        -bm25(knowledge_turns_fts) AS score
      FROM knowledge_turns_fts
      JOIN knowledge_turns t ON t.rowid = knowledge_turns_fts.rowid
      WHERE ${conditions.join(" AND ")}
      ORDER BY score DESC
      LIMIT ?
    `;

    const result = await this.db.prepare(sql).bind(...params).all<
      D1TurnRow & { score: number }
    >();

    return result.results.map((r) => ({
      row: rowToKnowledgeTurn(r),
      score: r.score,
    }));
  }

  // ── getBySessionId ─────────────────────────────────────────────────────────

  async getBySessionId(sessionId: string): Promise<KnowledgeTurnRow[]> {
    const result = await this.db
      .prepare(
        `SELECT turn_id, session_id, project, user_id, speaker, content, message_index, created_at
           FROM knowledge_turns
          WHERE session_id = ?
          ORDER BY message_index ASC`
      )
      .bind(sessionId)
      .all<D1TurnRow>();
    return result.results.map(rowToKnowledgeTurn);
  }

  // ── getByIds ───────────────────────────────────────────────────────────────

  async getByIds(turnIds: string[]): Promise<KnowledgeTurnRow[]> {
    if (turnIds.length === 0) return [];
    // D1 has no array binding. Build a parameterized IN clause: ?,?,?...
    const placeholders = turnIds.map(() => "?").join(", ");
    // nosemgrep: sql-injection-template-literal -- placeholders is ? × N, never user data
    const sql = `
      SELECT turn_id, session_id, project, user_id, speaker, content, message_index, created_at
        FROM knowledge_turns
       WHERE turn_id IN (${placeholders})
    `;
    const result = await this.db
      .prepare(sql)
      .bind(...turnIds)
      .all<D1TurnRow>();
    return result.results.map(rowToKnowledgeTurn);
  }

  // ── deleteBySessionId ──────────────────────────────────────────────────────

  async deleteBySessionId(sessionId: string): Promise<void> {
    // Remove embeddings for turns in this session first, then the turns themselves.
    // Use db.batch() for atomicity.
    await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM knowledge_turn_embeddings
            WHERE turn_id IN (SELECT turn_id FROM knowledge_turns WHERE session_id = ?)`
        )
        .bind(sessionId),
      this.db
        .prepare("DELETE FROM knowledge_turns WHERE session_id = ?")
        .bind(sessionId),
    ]);
  }

  // ── count ──────────────────────────────────────────────────────────────────

  async count(): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS cnt FROM knowledge_turns")
      .first<{ cnt: number }>();
    return row?.cnt ?? 0;
  }
}
