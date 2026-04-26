/**
 * NpcTurnStore — wraps the world.db `npc_turns` table.
 *
 * Stores raw conversation turns verbatim with FTS5 indexing. Used by the
 * recall path's turn-level retrieval lane (TIR). Distinct from
 * `NpcMemoryEngine`, which stores extraction-derived atomic facts.
 *
 * Spec: 2026-04-26-npc-recall-tir-qdp-design.md
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface NpcTurnInput {
  npcId: string;
  playerId: string;
  speaker: string;        // 'player' | 'npc'
  content: string;
  sessionId?: string;     // forward-compat, unused in Phase 0
}

export interface NpcTurn {
  turnId: string;
  npcId: string;
  playerId: string;
  speaker: string;
  content: string;
  createdAt: number;
  sessionId: string | null;
}

export interface NpcTurnHit extends NpcTurn {
  bm25: number;           // negated FTS5 score: higher = better, matches relevance convention
}

export interface SearchOptions {
  npcId: string;
  limit: number;
}

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

export class NpcTurnStore {
  private readonly db: Database.Database;
  private readonly stmtInsert: Database.Statement;
  private readonly stmtCount: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.stmtInsert = db.prepare(`
      INSERT INTO npc_turns
        (turn_id, npc_id, player_id, speaker, content, created_at, session_id)
      VALUES
        (@turn_id, @npc_id, @player_id, @speaker, @content, @created_at, @session_id)
    `);
    this.stmtCount = db.prepare(`SELECT COUNT(*) AS cnt FROM npc_turns WHERE npc_id = ?`);
  }

  add(input: NpcTurnInput): string {
    const turnId = randomUUID();
    this.stmtInsert.run({
      turn_id: turnId,
      npc_id: input.npcId,
      player_id: input.playerId,
      speaker: input.speaker,
      content: input.content,
      created_at: Date.now(),
      session_id: input.sessionId ?? null,
    });
    return turnId;
  }

  /**
   * FTS5 search scoped to a single NPC.
   * SQLite FTS5 returns BM25 where lower = better; we negate so callers
   * can treat "higher = more relevant" uniformly across the recall pipeline.
   */
  search(query: string, opts: SearchOptions): NpcTurnHit[] {
    if (!query || query.trim().length === 0) return [];
    const ftsQuery = sanitizeFtsQuery(query);
    if (ftsQuery.length === 0) return [];
    const stmt = this.db.prepare(`
      SELECT t.*, bm25(npc_turns_fts) AS bm25_raw
      FROM npc_turns t
      JOIN npc_turns_fts f ON f.rowid = t.rowid
      WHERE f.npc_turns_fts MATCH ?
        AND t.npc_id = ?
      ORDER BY bm25_raw ASC
      LIMIT ?
    `);
    const rows = stmt.all(ftsQuery, opts.npcId, opts.limit) as Record<string, unknown>[];
    return rows.map(r => this.rowToHit(r));
  }

  count(npcId: string): number {
    const row = this.stmtCount.get(npcId) as { cnt: number };
    return row.cnt;
  }

  private rowToHit(row: Record<string, unknown>): NpcTurnHit {
    return {
      turnId: row.turn_id as string,
      npcId: row.npc_id as string,
      playerId: row.player_id as string,
      speaker: row.speaker as string,
      content: row.content as string,
      createdAt: row.created_at as number,
      sessionId: (row.session_id as string | null) ?? null,
      bm25: -(row.bm25_raw as number),
    };
  }
}
