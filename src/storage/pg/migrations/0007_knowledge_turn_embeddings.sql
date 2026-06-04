-- Migration 0007: knowledge_turn_embeddings table (Postgres)
--
-- Per-turn BYTEA embedding vectors for the dense turn-lane.
-- Mirrors SQLite's knowledge_turn_embeddings table from database.ts.
-- Uses BYTEA (not pgvector) — JS-side cosine via rankByCosine,
-- matching the pattern in the existing embeddings table + PgVectorSearch.
--
-- No turn-write trigger: PG has no conversation-ingest path today.
-- The write side is provided by PgKnowledgeTurnStore.embedTurns()
-- (called from insert/bulkInsert when an embedder is injected).
-- On empty table, searchTurnEmbeddings returns [] — FTS5 fallback intact.
--
-- Spec: 2026-06-03-dense-turn-lane-production-design.md (PR2)
-- Forward-only, additive-only (D1 constraint).

CREATE TABLE IF NOT EXISTS knowledge_turn_embeddings (
  turn_id     TEXT    PRIMARY KEY REFERENCES knowledge_turns(turn_id) ON DELETE CASCADE,
  embedding   BYTEA   NOT NULL,
  model       TEXT    NOT NULL,
  format      TEXT    NOT NULL DEFAULT 'float32',
  created_at  BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kte_model ON knowledge_turn_embeddings(model);
