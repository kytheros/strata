/**
 * SqliteKnowledgeTurnStore — SQLite implementation of IKnowledgeTurnStore.
 *
 * Wraps the `knowledge_turns` table (created by migration 0004 in database.ts).
 * Uses FTS5 MATCH against `knowledge_turns_fts` with BM25 ranking for
 * searchByQuery. Prepared statements are cached at construction time per the
 * D2 constraint (no module-level caches — state is scoped to the store instance).
 *
 * Mirrors NpcTurnStore (src/transports/npc-turn-store.ts), replacing NPC-specific
 * `npc_id` / `player_id` with multi-tenant `project` + `user_id` fields.
 *
 * Spec: 2026-05-01-tirqdp-community-port-design.md
 * Ticket: TIRQDP-1.2
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  IKnowledgeTurnStore,
  KnowledgeTurnInput,
  KnowledgeTurnRow,
  KnowledgeTurnHit,
  KnowledgeTurnSearchOptions,
} from "./interfaces/knowledge-turn-store.js";
import type { GeminiEmbedder } from "../extensions/embeddings/gemini-embedder.js";
import { quantize } from "../extensions/quantization/turbo-quant.js";
import { CONFIG } from "../config.js";

// ── FTS query sanitizer ───────────────────────────────────────────────────────

/**
 * Reduce a free-text query to FTS5-safe alphanumeric tokens, OR-joined.
 *
 * SQLite FTS5's MATCH syntax treats apostrophes, quotes, parens, and a
 * handful of other characters as syntactic — passing user phrases like
 * "what's the wizard's true name" raw produces a parse error.
 *
 * This sanitizer:
 *   - lowercases
 *   - splits on non-alphanumerics (drops punctuation)
 *   - drops single-character tokens
 *   - joins with " OR " so the query matches any token (FTS5's rank
 *     formula already prefers documents that match more terms; explicit
 *     OR avoids the implicit-AND trap where a single missing word voids
 *     the entire match).
 *
 * Returns an empty string if no usable tokens remain.
 */
function sanitizeFtsQuery(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 2);
  return tokens.join(" OR ");
}

// ── row mapper ────────────────────────────────────────────────────────────────

function rowToKnowledgeTurn(row: Record<string, unknown>): KnowledgeTurnRow {
  return {
    turnId: row.turn_id as string,
    sessionId: row.session_id as string,
    project: (row.project as string | null) ?? null,
    userId: (row.user_id as string | null) ?? null,
    speaker: row.speaker as string,
    content: row.content as string,
    messageIndex: row.message_index as number,
    createdAt: row.created_at as number,
  };
}

// ── store ─────────────────────────────────────────────────────────────────────

export class SqliteKnowledgeTurnStore implements IKnowledgeTurnStore {
  private readonly db: Database.Database;
  private readonly embedder: GeminiEmbedder | null;

  // Cached prepared statements — scoped to the instance, never module-level (D2)
  private readonly stmtInsert: Database.Statement;
  private readonly stmtCount: Database.Statement;
  private readonly stmtGetBySession: Database.Statement;
  private readonly stmtDeleteBySession: Database.Statement;
  private readonly stmtDeleteEmbBySession: Database.Statement;
  private readonly upsertTurnEmbedding: Database.Statement;

  /** In-flight embedding promises from single inserts (awaited by flushPendingEmbeddings). */
  private pendingEmbeddings: Set<Promise<void>> = new Set();

  constructor(db: Database.Database, embedder?: GeminiEmbedder | null) {
    this.db = db;
    this.embedder = embedder ?? null;

    this.stmtInsert = db.prepare(`
      INSERT INTO knowledge_turns
        (turn_id, session_id, project, user_id, speaker, content, message_index, created_at)
      VALUES
        (@turn_id, @session_id, @project, @user_id, @speaker, @content, @message_index, @created_at)
    `);

    this.stmtCount = db.prepare(`SELECT COUNT(*) AS cnt FROM knowledge_turns`);

    this.stmtGetBySession = db.prepare(`
      SELECT * FROM knowledge_turns
      WHERE session_id = ?
      ORDER BY message_index ASC
    `);

    this.stmtDeleteBySession = db.prepare(
      `DELETE FROM knowledge_turns WHERE session_id = ?`
    );

    this.stmtDeleteEmbBySession = db.prepare(
      `DELETE FROM knowledge_turn_embeddings
       WHERE turn_id IN (SELECT turn_id FROM knowledge_turns WHERE session_id = ?)`
    );

    this.upsertTurnEmbedding = db.prepare(
      "INSERT OR REPLACE INTO knowledge_turn_embeddings (turn_id, embedding, model, created_at, format) VALUES (?, ?, ?, ?, ?)"
    );
  }

  /** Encode a Float32 embedding into storage format (quantized or raw float32). */
  private encodeEmbedding(vec: Float32Array): { buf: Buffer; format: string } {
    if (CONFIG.quantization.enabled) {
      const bitWidth = CONFIG.quantization.bitWidth as 1 | 2 | 4 | 8;
      const quantized = quantize(vec, bitWidth);
      return { buf: Buffer.from(quantized), format: `tq${bitWidth}` };
    }
    return { buf: Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), format: "float32" };
  }

  /** Embed a set of (turnId, content) pairs and upsert in one transaction. Never throws.
   * Filters out empty/whitespace-only content before calling embedBatch — the Gemini
   * embedding API returns 400 for empty content, which would drop all vectors in the
   * whole batch (silent recall loss). Empty turns have nothing meaningful to embed. */
  private async embedTurns(ids: string[], contents: string[]): Promise<void> {
    if (!this.embedder || ids.length === 0) return;
    try {
      // Filter to non-empty content only, preserving id↔content alignment.
      const filteredIds: string[] = [];
      const filteredContents: string[] = [];
      for (let i = 0; i < ids.length; i++) {
        if (contents[i].trim().length > 0) {
          filteredIds.push(ids[i]);
          filteredContents.push(contents[i]);
        }
      }
      if (filteredIds.length === 0) return;

      const vectors = await this.embedder.embedBatch(filteredContents, CONFIG.search.denseTurnLane.docTaskType);
      const txn = this.db.transaction(() => {
        const now = Date.now();
        for (let i = 0; i < vectors.length; i++) {
          const { buf, format } = this.encodeEmbedding(vectors[i]);
          this.upsertTurnEmbedding.run(filteredIds[i], buf, "gemini-embedding-001", now, format);
        }
      });
      txn();
    } catch (err) {
      console.error(`[strata] Failed to embed ${ids.length} turns:`, err);
    }
  }

  // ── insert ─────────────────────────────────────────────────────────────────

  async insert(turn: KnowledgeTurnInput): Promise<string> {
    const turnId = randomUUID();
    this.stmtInsert.run({
      turn_id: turnId,
      session_id: turn.sessionId,
      project: turn.project ?? null,
      user_id: turn.userId ?? null,
      speaker: turn.speaker,
      content: turn.content,
      message_index: turn.messageIndex,
      created_at: turn.createdAt ?? Date.now(),
    });
    if (this.embedder) {
      const p = this.embedTurns([turnId], [turn.content]).finally(() => {
        this.pendingEmbeddings.delete(p);
      });
      this.pendingEmbeddings.add(p);
    }
    return turnId;
  }

  /** Await all in-flight single-insert embeddings. */
  async flushPendingEmbeddings(): Promise<number> {
    const count = this.pendingEmbeddings.size;
    if (count === 0) return 0;
    await Promise.all([...this.pendingEmbeddings]);
    return count;
  }

  // ── bulkInsert ─────────────────────────────────────────────────────────────

  async bulkInsert(turns: KnowledgeTurnInput[]): Promise<string[]> {
    const ids: string[] = [];
    const insertMany = this.db.transaction(() => {
      for (const turn of turns) {
        const turnId = randomUUID();
        this.stmtInsert.run({
          turn_id: turnId,
          session_id: turn.sessionId,
          project: turn.project ?? null,
          user_id: turn.userId ?? null,
          speaker: turn.speaker,
          content: turn.content,
          message_index: turn.messageIndex,
          created_at: turn.createdAt ?? Date.now(),
        });
        ids.push(turnId);
      }
    });
    insertMany();
    if (this.embedder && turns.length > 0) {
      await this.embedTurns(ids, turns.map((t) => t.content));
    }
    return ids;
  }

  // ── searchByQuery ──────────────────────────────────────────────────────────

  /**
   * FTS5 search scoped to a user_id (and optionally project).
   *
   * SQLite FTS5 returns BM25 where lower = better (negative values); we negate
   * so callers can treat "higher = more relevant" uniformly across the recall
   * pipeline (mirrors NpcTurnStore.search() convention).
   *
   * user_id scoping:
   *   - userId is a string  → WHERE user_id = ?
   *   - userId is null      → WHERE user_id IS NULL
   *   - userId is undefined → no user_id filter (all users)
   */
  async searchByQuery(query: string, opts: KnowledgeTurnSearchOptions): Promise<KnowledgeTurnHit[]> {
    if (!query || query.trim().length === 0) return [];
    const ftsQuery = sanitizeFtsQuery(query);
    if (ftsQuery.length === 0) return [];

    // Build the WHERE clause dynamically based on opts
    const conditions: string[] = ["f.knowledge_turns_fts MATCH ?"];
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

    const sql = `
      SELECT t.*, -bm25(knowledge_turns_fts) AS score
      FROM knowledge_turns t
      JOIN knowledge_turns_fts f ON f.rowid = t.rowid
      WHERE ${conditions.join(" AND ")}
      ORDER BY score DESC
      LIMIT ?
    `;

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(r => ({
      row: rowToKnowledgeTurn(r),
      score: r.score as number,
    }));
  }

  // ── getBySessionId ─────────────────────────────────────────────────────────

  async getBySessionId(sessionId: string): Promise<KnowledgeTurnRow[]> {
    const rows = this.stmtGetBySession.all(sessionId) as Record<string, unknown>[];
    return rows.map(rowToKnowledgeTurn);
  }

  // ── getByIds ───────────────────────────────────────────────────────────────

  async getByIds(turnIds: string[]): Promise<KnowledgeTurnRow[]> {
    if (turnIds.length === 0) return [];
    const placeholders = turnIds.map(() => "?").join(", ");
    // nosemgrep: sql-injection-template-literal -- $placeholders is always "?,?,…" (one ? per id); values bind via ...turnIds spread, no user data in the SQL string
    const rows = this.db
      .prepare(`SELECT * FROM knowledge_turns WHERE turn_id IN (${placeholders})`)
      .all(...turnIds) as Record<string, unknown>[];
    return rows.map(rowToKnowledgeTurn);
  }

  // ── deleteBySessionId ──────────────────────────────────────────────────────

  async deleteBySessionId(sessionId: string): Promise<void> {
    const del = this.db.transaction(() => {
      this.stmtDeleteEmbBySession.run(sessionId); // embeddings first (turn rows still present)
      this.stmtDeleteBySession.run(sessionId);    // FTS kept consistent by the ad trigger
    });
    del();
  }

  // ── count ──────────────────────────────────────────────────────────────────

  async count(): Promise<number> {
    const row = this.stmtCount.get() as { cnt: number };
    return row.cnt;
  }
}
