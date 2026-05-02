-- Migration 0004: Add knowledge_turns table for Turn Isolation Retrieval (TIR).
--
-- Adds a turn-level FTS5 index alongside the existing chunk-level knowledge table.
-- The turn lane is additive — no changes to knowledge or knowledge_fts.
-- knowledge_turns starts empty; the turn lane contributes nothing to RRF until
-- IncrementalIndexer populates it during ingest.
--
-- Schema mirrors the npc_turns table (NPC v2 path) with project + user_id
-- added for Community multi-tenant scoping.

CREATE TABLE IF NOT EXISTS knowledge_turns (
  turn_id      TEXT PRIMARY KEY,        -- UUID v4
  session_id   TEXT NOT NULL,           -- maps to existing knowledge.session_id
  project      TEXT,                    -- nullable; project scoping
  user_id      TEXT,                    -- nullable; multi-tenant scope
  speaker      TEXT NOT NULL,           -- 'user' | 'assistant' | 'system'
  content      TEXT NOT NULL,           -- raw turn text, verbatim
  message_index INTEGER NOT NULL,       -- ordinal within session (for +/-1 expansion)
  created_at   INTEGER NOT NULL         -- epoch ms
);

CREATE INDEX IF NOT EXISTS idx_knowledge_turns_session ON knowledge_turns(session_id, message_index);
CREATE INDEX IF NOT EXISTS idx_knowledge_turns_project ON knowledge_turns(project, created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_turns_fts USING fts5(
  content,
  content='knowledge_turns',
  content_rowid='rowid',
  tokenize='porter'
);

CREATE TRIGGER IF NOT EXISTS knowledge_turns_ai AFTER INSERT ON knowledge_turns BEGIN
  INSERT INTO knowledge_turns_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS knowledge_turns_ad AFTER DELETE ON knowledge_turns BEGIN
  INSERT INTO knowledge_turns_fts(knowledge_turns_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;

-- Bump schema version.
INSERT OR REPLACE INTO index_meta(key, value) VALUES ('schema_version', '4');
