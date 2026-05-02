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

  // Cached prepared statements — scoped to the instance, never module-level (D2)
  private readonly stmtInsert: Database.Statement;
  private readonly stmtCount: Database.Statement;
  private readonly stmtGetBySession: Database.Statement;
  private readonly stmtDeleteBySession: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    this.stmtInsert = db.prepare(`
      INSERT INTO knowledge_turns
        (turn_id, session_id, project, user_id, speaker, content, message_index, created_at)
      VALUES
        (@turn_id, @session_id, @project, @user_id, @speaker, @content, @message_index, @created_at)
    `);

    this.stmtCount = db.prepare(
      `SELECT COUNT(*) AS cnt FROM knowledge_turns`
    );

    this.stmtGetBySession = db.prepare(`
      SELECT * FROM knowledge_turns
      WHERE session_id = ?
      ORDER BY message_index ASC
    `);

    this.stmtDeleteBySession = db.prepare(
      `DELETE FROM knowledge_turns WHERE session_id = ?`
    );
  }

  // ── insert ─────────────────────────────────────────────────────────────────

  insert(turn: KnowledgeTurnInput): string {
    const turnId = randomUUID();
    this.stmtInsert.run({
      turn_id: turnId,
      session_id: turn.sessionId,
      project: turn.project ?? null,
      user_id: turn.userId ?? null,
      speaker: turn.speaker,
      content: turn.content,
      message_index: turn.messageIndex,
      created_at: Date.now(),
    });
    return turnId;
  }

  // ── bulkInsert ─────────────────────────────────────────────────────────────

  bulkInsert(turns: KnowledgeTurnInput[]): string[] {
    const ids: string[] = [];
    const insertMany = this.db.transaction(() => {
      for (const turn of turns) {
        ids.push(this.insert(turn));
      }
    });
    insertMany();
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
  searchByQuery(query: string, opts: KnowledgeTurnSearchOptions): KnowledgeTurnHit[] {
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

  getBySessionId(sessionId: string): KnowledgeTurnRow[] {
    const rows = this.stmtGetBySession.all(sessionId) as Record<string, unknown>[];
    return rows.map(rowToKnowledgeTurn);
  }

  // ── deleteBySessionId ──────────────────────────────────────────────────────

  deleteBySessionId(sessionId: string): void {
    this.stmtDeleteBySession.run(sessionId);
    // The knowledge_turns_ad trigger automatically removes from knowledge_turns_fts.
  }

  // ── count ──────────────────────────────────────────────────────────────────

  count(): number {
    const row = this.stmtCount.get() as { cnt: number };
    return row.cnt;
  }
}
