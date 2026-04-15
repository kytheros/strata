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
