import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema, SCHEMA_VERSION } from '../../src/transports/world-schema.js';

test('applySchema creates all tables', () => {
  const db = new Database(':memory:');
  applySchema(db);
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map((r: any) => r.name);
  expect(tables).toEqual(expect.arrayContaining([
    'npc_profiles',
    'npc_memories',
    'npc_memories_fts',
    'npc_acquaintances',
    'player_characters',
    'relationships',
    'schema_meta',
  ]));
});

test('applySchema is idempotent', () => {
  const db = new Database(':memory:');
  applySchema(db);
  applySchema(db);
  const v = db.prepare("SELECT value FROM schema_meta WHERE key='version'").get() as any;
  expect(v.value).toBe(String(SCHEMA_VERSION));
});

test('applySchema creates npc_turns table and FTS5 mirror', () => {
  const db = new Database(':memory:');
  applySchema(db);
  const objects = db.prepare(
    "SELECT name FROM sqlite_master WHERE name IN ('npc_turns','npc_turns_fts')"
  ).all().map((r: any) => r.name);
  const names = new Set(objects);
  expect(names.has('npc_turns')).toBe(true);
  expect(names.has('npc_turns_fts')).toBe(true);
});

test('npc_turns FTS triggers keep mirror in sync', () => {
  const db = new Database(':memory:');
  applySchema(db);
  db.prepare(`
    INSERT INTO npc_turns (turn_id, npc_id, player_id, speaker, content, created_at, session_id)
    VALUES ('t1', 'goran', 'p1', 'player', 'the password is moonstone', 1, NULL)
  `).run();
  const hits = db.prepare(`
    SELECT t.turn_id FROM npc_turns t
    JOIN npc_turns_fts f ON f.rowid = t.rowid
    WHERE f.npc_turns_fts MATCH 'moonstone'
  `).all() as { turn_id: string }[];
  expect(hits.length).toBe(1);
  expect(hits[0].turn_id).toBe('t1');
});

import { describe, it } from 'vitest';

describe("npc_memories schema (Spec 2026-04-28 conflict resolution)", () => {
  it("creates subject_key, predicate_key, superseded_by columns on a fresh DB", () => {
    const db = new Database(":memory:");
    applySchema(db);
    const cols = db.prepare("PRAGMA table_info(npc_memories)").all() as Array<{name: string}>;
    const names = cols.map(c => c.name);
    expect(names).toContain("subject_key");
    expect(names).toContain("predicate_key");
    expect(names).toContain("superseded_by");
  });

  it("creates the active-collision partial index", () => {
    const db = new Database(":memory:");
    applySchema(db);
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='npc_memories'"
    ).all() as Array<{name: string}>;
    expect(indexes.map(i => i.name)).toContain("idx_npc_memories_subject_pred_active");
  });

  it("ALTER TABLE migration is idempotent on a pre-existing v2 DB", () => {
    const db = new Database(":memory:");
    // Simulate pre-spec DB: apply the OLD schema (no new columns).
    db.exec(`
      CREATE TABLE npc_memories (
        memory_id TEXT PRIMARY KEY, npc_id TEXT NOT NULL, content TEXT NOT NULL,
        tags_json TEXT, importance INTEGER NOT NULL DEFAULT 50,
        anchor_depth INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        last_accessed INTEGER NOT NULL, access_count INTEGER NOT NULL DEFAULT 0,
        extras_json TEXT
      );
      CREATE VIRTUAL TABLE npc_memories_fts USING fts5(content, content='npc_memories', content_rowid='rowid');
    `);
    // Insert a row with the old schema to confirm migration preserves data.
    db.exec(`
      INSERT INTO npc_memories (memory_id, npc_id, content, importance, created_at, last_accessed)
      VALUES ('legacy-1', 'goran', 'old fact', 50, 1000, 1000)
    `);
    // Now run the new applySchema() — should ADD the new columns without breaking the legacy row.
    applySchema(db);
    applySchema(db);   // idempotent — second call must not throw
    const row = db.prepare("SELECT memory_id, content, subject_key, predicate_key, superseded_by FROM npc_memories WHERE memory_id='legacy-1'").get() as Record<string, unknown>;
    expect(row.content).toBe("old fact");
    expect(row.subject_key).toBeNull();
    expect(row.predicate_key).toBeNull();
    expect(row.superseded_by).toBeNull();
  });

  it("bumps SCHEMA_VERSION to 3", () => {
    expect(SCHEMA_VERSION).toBe(3);
  });
});
