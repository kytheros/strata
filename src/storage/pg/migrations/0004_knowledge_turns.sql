-- Migration 0004: knowledge_turns table (Postgres)
--
-- Postgres equivalent of the SQLite knowledge_turns + knowledge_turns_fts tables
-- from database.ts. Uses a GENERATED ALWAYS tsvector column + GIN index in place
-- of FTS5 virtual tables. No ALTER TABLE on existing tables (D1 — additive only).
--
-- Spec: 2026-05-01-tirqdp-community-port-design.md
-- Ticket: TIRQDP-1.3

CREATE TABLE IF NOT EXISTS knowledge_turns (
  turn_id       TEXT        PRIMARY KEY,
  session_id    TEXT        NOT NULL,
  project       TEXT,
  user_id       TEXT,
  speaker       TEXT        NOT NULL CHECK(speaker IN ('user', 'assistant', 'system')),
  content       TEXT        NOT NULL,
  message_index INTEGER     NOT NULL DEFAULT 0,
  created_at    BIGINT      NOT NULL,

  -- Full-text search column: auto-updated whenever content changes.
  -- Replaces the FTS5 virtual table + triggers used in the SQLite backend.
  tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(content, ''))
  ) STORED
);

-- Scoping indexes (mirror the SQLite UNIQUE(session_id, message_index) + project+created_at indexes)
CREATE INDEX IF NOT EXISTS idx_kt_session_msg  ON knowledge_turns(session_id, message_index);
CREATE INDEX IF NOT EXISTS idx_kt_project_ts   ON knowledge_turns(project, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kt_user         ON knowledge_turns(user_id);

-- GIN index for fast tsvector lookups (replaces FTS5's implicit index)
CREATE INDEX IF NOT EXISTS idx_kt_tsv          ON knowledge_turns USING GIN (tsv);
