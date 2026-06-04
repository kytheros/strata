-- Migration 0006: Add knowledge_turn_embeddings table for dense turn-lane (D1).
--
-- Per-turn vector store keyed by turn_id. Separate from the `embeddings` table
-- (which is keyed by knowledge entry id) to avoid JOIN namespace collision.
-- Mirrors SQLite database.ts Migration 0006 (knowledge_turn_embeddings).
-- D1 has no turn-write path yet; table starts empty and no-ops to FTS5 until
-- a future Community ingest API populates it.
--
-- D1 batch limit: 100 statements per db.batch(). Each knowledge_turns INSERT fires
-- knowledge_turns_ai (+1 stmt) so max safe bulkInsert chunk = 50 turns per batch.
-- (This comment documents the constraint; enforcement is in D1KnowledgeTurnStore.)

CREATE TABLE IF NOT EXISTS knowledge_turn_embeddings (
  turn_id    TEXT PRIMARY KEY,
  embedding  BLOB NOT NULL,
  model      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  format     TEXT NOT NULL DEFAULT 'float32'
);

CREATE INDEX IF NOT EXISTS idx_knowledge_turn_embeddings_turn
  ON knowledge_turn_embeddings(turn_id);

-- Bump schema version.
INSERT OR REPLACE INTO index_meta(key, value) VALUES ('schema_version', '5');
