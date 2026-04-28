import type Database from 'better-sqlite3';

export const SCHEMA_VERSION = 3;

function ensureColumn(db: Database.Database, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name: string}>;
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS npc_profiles (
      npc_id              TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      role                TEXT,
      alignment_ethical   TEXT,
      alignment_moral     TEXT,
      default_trust       INTEGER NOT NULL DEFAULT 50,
      gossip_trait        TEXT NOT NULL DEFAULT 'normal',
      decay_profile_name  TEXT NOT NULL DEFAULT 'normal',
      factions_json       TEXT,
      faction_biases_json TEXT,
      propagate_tags_json TEXT,
      tag_rules_json      TEXT,
      decay_config_json   TEXT,
      extras_json         TEXT,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS npc_memories (
      memory_id       TEXT PRIMARY KEY,
      npc_id          TEXT NOT NULL,
      content         TEXT NOT NULL,
      tags_json       TEXT,
      importance      INTEGER NOT NULL DEFAULT 50,
      anchor_depth    INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL,
      last_accessed   INTEGER NOT NULL,
      access_count    INTEGER NOT NULL DEFAULT 0,
      extras_json     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memories_npc ON npc_memories(npc_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS npc_memories_fts
      USING fts5(content, content='npc_memories', content_rowid='rowid');

    -- FTS5 triggers to keep npc_memories_fts in sync with npc_memories
    CREATE TRIGGER IF NOT EXISTS npc_memories_ai
      AFTER INSERT ON npc_memories BEGIN
        INSERT INTO npc_memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    CREATE TRIGGER IF NOT EXISTS npc_memories_ad
      AFTER DELETE ON npc_memories BEGIN
        INSERT INTO npc_memories_fts(npc_memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
    CREATE TRIGGER IF NOT EXISTS npc_memories_au
      AFTER UPDATE ON npc_memories BEGIN
        INSERT INTO npc_memories_fts(npc_memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO npc_memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

    CREATE TABLE IF NOT EXISTS npc_acquaintances (
      npc_id            TEXT NOT NULL,
      other_npc_id      TEXT NOT NULL,
      trust             INTEGER NOT NULL DEFAULT 50,
      last_interaction  INTEGER NOT NULL,
      interaction_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (npc_id, other_npc_id)
    );

    CREATE TABLE IF NOT EXISTS player_characters (
      player_id           TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      alignment_ethical   TEXT,
      alignment_moral     TEXT,
      factions_json       TEXT,
      extras_json         TEXT,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS relationships (
      player_id     TEXT NOT NULL,
      npc_id        TEXT NOT NULL,
      trust         INTEGER NOT NULL DEFAULT 50,
      anchor_depth  INTEGER NOT NULL DEFAULT 0,
      anchor_type   TEXT,
      last_trust_update INTEGER NOT NULL,
      extras_json   TEXT,
      PRIMARY KEY (player_id, npc_id)
    );

    -- TIR turn-level retrieval lane (Spec 2026-04-26-npc-recall-tir-qdp).
    -- Holds verbatim conversation turns, indexed via FTS5 alongside the
    -- existing npc_memories table (extracted facts).
    CREATE TABLE IF NOT EXISTS npc_turns (
      turn_id    TEXT PRIMARY KEY,
      npc_id     TEXT NOT NULL,
      player_id  TEXT NOT NULL,
      speaker    TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      session_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_npc_turns_npc ON npc_turns(npc_id);
    CREATE INDEX IF NOT EXISTS idx_npc_turns_npc_created ON npc_turns(npc_id, created_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS npc_turns_fts
      USING fts5(content, content='npc_turns', content_rowid='rowid');

    CREATE TRIGGER IF NOT EXISTS npc_turns_ai
      AFTER INSERT ON npc_turns BEGIN
        INSERT INTO npc_turns_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    CREATE TRIGGER IF NOT EXISTS npc_turns_ad
      AFTER DELETE ON npc_turns BEGIN
        INSERT INTO npc_turns_fts(npc_turns_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
    CREATE TRIGGER IF NOT EXISTS npc_turns_au
      AFTER UPDATE ON npc_turns BEGIN
        INSERT INTO npc_turns_fts(npc_turns_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO npc_turns_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
  `);

  // Spec 2026-04-28 conflict resolution: add subject/predicate/supersede columns
  // idempotently so both fresh DBs and pre-existing DBs get the new columns.
  ensureColumn(db, "npc_memories", "subject_key", "TEXT");
  ensureColumn(db, "npc_memories", "predicate_key", "TEXT");
  ensureColumn(db, "npc_memories", "superseded_by", "TEXT");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_npc_memories_subject_pred_active
      ON npc_memories (npc_id, subject_key, predicate_key)
      WHERE superseded_by IS NULL
        AND subject_key IS NOT NULL
        AND predicate_key IS NOT NULL;
  `);

  db.prepare(
    "INSERT INTO schema_meta(key,value) VALUES('version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(String(SCHEMA_VERSION));
}
