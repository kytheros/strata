/**
 * NPC memory engine — stores and retrieves NPC memories against the
 * world.db `npc_memories` table with FTS5 full-text search.
 *
 * One engine instance per NPC; all queries are scoped by npc_id.
 * The FTS5 virtual table is kept in sync via triggers defined in world-schema.ts.
 *
 * Spec: 2026-04-15-world-scope-refactor-design.md
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface NpcMemoryInput {
  content: string;
  tags: string[];
  importance: number;
  anchorDepth?: number;
  subjectKey?: string | null;       // NEW (Spec 2026-04-28)
  predicateKey?: string | null;     // NEW
}

export interface NpcMemory {
  id: string;
  npcId: string;
  content: string;
  tags: string[];
  importance: number;
  anchorDepth: number;
  createdAt: number;
  lastAccessed: number;
  accessCount: number;
}

/** See npc-turn-store.ts for rationale. Duplicated locally to keep the
 * engines decoupled — they're independent stores that happen to share
 * a sanitizer pattern. If a third caller emerges, lift to a shared util. */
function sanitizeFtsQuery(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 2);
  return tokens.join(" OR ");
}

export class NpcMemoryEngine {
  private readonly db: Database.Database;
  private readonly npcId: string;

  private readonly stmtInsert: Database.Statement;
  private readonly stmtGetById: Database.Statement;
  private readonly stmtGetAll: Database.Statement;
  private readonly stmtDelete: Database.Statement;
  private readonly stmtDeleteAll: Database.Statement;
  private readonly stmtRecordAccess: Database.Statement;
  private readonly stmtCount: Database.Statement;
  private readonly stmtMarkSuperseded: Database.Statement;

  constructor(db: Database.Database, npcId: string) {
    this.db = db;
    this.npcId = npcId;

    this.stmtInsert = db.prepare(`
      INSERT INTO npc_memories
        (memory_id, npc_id, content, tags_json, importance, anchor_depth,
         created_at, last_accessed, access_count,
         subject_key, predicate_key, superseded_by)
      VALUES
        (@memory_id, @npc_id, @content, @tags_json, @importance, @anchor_depth,
         @now, @now, 0,
         @subject_key, @predicate_key, NULL)
    `);

    this.stmtGetById = db.prepare(`
      SELECT * FROM npc_memories WHERE memory_id = ? AND npc_id = ?
    `);

    this.stmtGetAll = db.prepare(`
      SELECT * FROM npc_memories WHERE npc_id = ? ORDER BY importance DESC, created_at DESC
    `);

    this.stmtDelete = db.prepare(`
      DELETE FROM npc_memories WHERE memory_id = ? AND npc_id = ?
    `);

    this.stmtDeleteAll = db.prepare(`
      DELETE FROM npc_memories WHERE npc_id = ?
    `);

    this.stmtRecordAccess = db.prepare(`
      UPDATE npc_memories
      SET access_count = access_count + 1, last_accessed = ?
      WHERE memory_id = ? AND npc_id = ?
    `);

    this.stmtCount = db.prepare(`
      SELECT COUNT(*) AS cnt FROM npc_memories WHERE npc_id = ?
    `);

    this.stmtMarkSuperseded = db.prepare(`
      UPDATE npc_memories
         SET superseded_by = @superseded_by
       WHERE npc_id = @npc_id
         AND subject_key = @subject_key
         AND predicate_key = @predicate_key
         AND memory_id != @exclude_id
         AND superseded_by IS NULL
    `);
  }

  /** Add a memory. Returns the generated memory_id. */
  add(input: NpcMemoryInput): string {
    const id = randomUUID();
    const now = Date.now();
    this.stmtInsert.run({
      memory_id: id,
      npc_id: this.npcId,
      content: input.content,
      tags_json: JSON.stringify(input.tags),
      importance: input.importance,
      anchor_depth: input.anchorDepth ?? 0,
      now,
      subject_key: input.subjectKey ?? null,
      predicate_key: input.predicateKey ?? null,
    });
    return id;
  }

  /**
   * Mark prior facts with the same (npc_id, subject_key, predicate_key) as
   * superseded by `supersededBy`. Excludes the row identified by `excludeId`
   * so a self-supersede on insert doesn't fire. Returns affected row count.
   */
  markSupersededByKey(opts: {
    npcId: string;
    subjectKey: string;
    predicateKey: string;
    excludeId: string;
    supersededBy: string;
  }): number {
    const result = this.stmtMarkSuperseded.run({
      npc_id: opts.npcId,
      subject_key: opts.subjectKey,
      predicate_key: opts.predicateKey,
      exclude_id: opts.excludeId,
      superseded_by: opts.supersededBy,
    });
    return Number(result.changes);
  }

  /** Get a single memory by ID (scoped to this NPC). Returns null if not found. */
  getById(id: string): NpcMemory | null {
    const row = this.stmtGetById.get(id, this.npcId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToMemory(row);
  }

  /** Get all memories for this NPC, ordered by importance desc. */
  getAll(): NpcMemory[] {
    const rows = this.stmtGetAll.all(this.npcId) as Record<string, unknown>[];
    return rows.map(r => this.rowToMemory(r));
  }

  /** Full-text search within this NPC's memories. */
  search(query: string): NpcMemory[] {
    if (!query || query.trim().length === 0) return [];
    // FTS5 match, filtered to this npcId via join back to npc_memories.
    // Sanitize the query into FTS5-safe alphanumeric tokens (OR-joined) so
    // free-text inputs like "what's the password?" don't trip FTS5 syntax.
    const ftsQuery = sanitizeFtsQuery(query);
    if (ftsQuery.length === 0) return [];
    const stmt = this.db.prepare(`
      SELECT m.*
      FROM npc_memories m
      JOIN npc_memories_fts fts ON fts.rowid = m.rowid
      WHERE fts.npc_memories_fts MATCH ?
        AND m.npc_id = ?
        AND m.superseded_by IS NULL
      ORDER BY m.importance DESC
    `);
    const rows = stmt.all(ftsQuery, this.npcId) as Record<string, unknown>[];
    return rows.map(r => this.rowToMemory(r));
  }

  /** Delete a memory by ID. No-op if not found. */
  delete(id: string): void {
    this.stmtDelete.run(id, this.npcId);
  }

  /** Delete all memories for this NPC. Returns the number of rows removed. */
  deleteAll(): number {
    const result = this.stmtDeleteAll.run(this.npcId);
    return Number(result.changes);
  }

  /** Increment access count and update last_accessed timestamp. */
  recordAccess(id: string): void {
    this.stmtRecordAccess.run(Date.now(), id, this.npcId);
  }

  /** Count of memories for this NPC. */
  count(): number {
    const row = this.stmtCount.get(this.npcId) as { cnt: number };
    return row.cnt;
  }

  private rowToMemory(row: Record<string, unknown>): NpcMemory {
    return {
      id: row.memory_id as string,
      npcId: row.npc_id as string,
      content: row.content as string,
      tags: row.tags_json ? JSON.parse(row.tags_json as string) as string[] : [],
      importance: row.importance as number,
      anchorDepth: row.anchor_depth as number,
      createdAt: row.created_at as number,
      lastAccessed: row.last_accessed as number,
      accessCount: row.access_count as number,
    };
  }
}
