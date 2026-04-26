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
