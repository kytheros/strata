-- Migration 0001: Baseline schema for Strata Postgres backend.
--
-- Contains all tables that were previously applied as a single flat DDL
-- block by createSchema() / PG_SCHEMA_STATEMENTS. Converted to a managed
-- migration so the runner can track it alongside incremental changes.
--
-- All statements use IF NOT EXISTS — safe to apply against a DB that already
-- has these tables (e.g. an existing v1 deployment being converted to the
-- runner).
--
-- Ticket: kytheros/strata#10

-- Core document chunks
CREATE TABLE IF NOT EXISTS documents (
  id            TEXT    PRIMARY KEY,
  session_id    TEXT    NOT NULL,
  project       TEXT    NOT NULL,
  tool          TEXT    NOT NULL DEFAULT 'claude-code',
  text          TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK(role IN ('user', 'assistant', 'mixed')),
  timestamp     BIGINT  NOT NULL,
  tool_names    TEXT,
  token_count   INTEGER NOT NULL DEFAULT 0,
  message_index INTEGER NOT NULL DEFAULT 0,
  user_scope    TEXT    NOT NULL DEFAULT 'default',
  importance    REAL,
  tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(text, ''))
  ) STORED
);

CREATE INDEX IF NOT EXISTS idx_documents_session   ON documents(session_id);
CREATE INDEX IF NOT EXISTS idx_documents_project   ON documents(project);
CREATE INDEX IF NOT EXISTS idx_documents_user      ON documents(user_scope);
CREATE INDEX IF NOT EXISTS idx_documents_timestamp ON documents(timestamp);
CREATE INDEX IF NOT EXISTS idx_documents_tsv       ON documents USING GIN (tsv);

-- Knowledge entries
CREATE TABLE IF NOT EXISTS knowledge (
  id            TEXT    PRIMARY KEY,
  type          TEXT    NOT NULL CHECK(type IN ('decision','solution','error_fix','pattern','learning','procedure','fact','preference','episodic')),
  project       TEXT    NOT NULL,
  session_id    TEXT    NOT NULL,
  timestamp     BIGINT  NOT NULL,
  summary       TEXT    NOT NULL,
  details       TEXT    NOT NULL DEFAULT '',
  tags          TEXT,
  related_files TEXT,
  occurrences   INTEGER DEFAULT 1,
  project_count INTEGER DEFAULT 1,
  extracted_at  BIGINT,
  updated_at    BIGINT,
  user_scope    TEXT    NOT NULL DEFAULT 'default',
  importance    REAL,
  tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(summary, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(details, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(tags, '')), 'C')
  ) STORED
);

CREATE INDEX IF NOT EXISTS idx_knowledge_project   ON knowledge(project);
CREATE INDEX IF NOT EXISTS idx_knowledge_type      ON knowledge(type);
CREATE INDEX IF NOT EXISTS idx_knowledge_user      ON knowledge(user_scope);
CREATE INDEX IF NOT EXISTS idx_knowledge_timestamp ON knowledge(timestamp);
CREATE INDEX IF NOT EXISTS idx_knowledge_tsv       ON knowledge USING GIN (tsv);

-- Knowledge mutation history (audit trail)
CREATE TABLE IF NOT EXISTS knowledge_history (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id    TEXT   NOT NULL,
  old_summary TEXT,
  new_summary TEXT,
  old_details TEXT,
  new_details TEXT,
  event       TEXT   NOT NULL CHECK(event IN ('add','update','delete')),
  created_at  BIGINT NOT NULL,
  CONSTRAINT fk_kh_entry FOREIGN KEY (entry_id) REFERENCES knowledge(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_kh_entry ON knowledge_history(entry_id);

-- Session summaries
CREATE TABLE IF NOT EXISTS summaries (
  session_id    TEXT   PRIMARY KEY,
  project       TEXT   NOT NULL,
  tool          TEXT   NOT NULL DEFAULT 'claude-code',
  topic         TEXT   NOT NULL DEFAULT '',
  start_time    BIGINT NOT NULL,
  end_time      BIGINT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  tools_used    TEXT,
  data          TEXT   NOT NULL,
  user_scope    TEXT   NOT NULL DEFAULT 'default'
);

CREATE INDEX IF NOT EXISTS idx_summaries_project  ON summaries(project);
CREATE INDEX IF NOT EXISTS idx_summaries_end_time ON summaries(end_time);
CREATE INDEX IF NOT EXISTS idx_summaries_user     ON summaries(user_scope);

-- Index metadata (key-value store)
CREATE TABLE IF NOT EXISTS index_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Embeddings for vector search (Float32Array serialized as bytea)
CREATE TABLE IF NOT EXISTS embeddings (
  id         TEXT   PRIMARY KEY,
  embedding  BYTEA  NOT NULL,
  model      TEXT   NOT NULL DEFAULT 'gemini-embedding-001',
  created_at BIGINT NOT NULL DEFAULT (extract(epoch from now())::bigint),
  format     TEXT   NOT NULL DEFAULT 'float32'
);

-- Entity tracking
CREATE TABLE IF NOT EXISTS entities (
  id             TEXT    PRIMARY KEY,
  name           TEXT    NOT NULL,
  type           TEXT    NOT NULL,
  canonical_name TEXT    NOT NULL,
  aliases        TEXT    DEFAULT '[]',
  first_seen     BIGINT  NOT NULL,
  last_seen      BIGINT  NOT NULL,
  mention_count  INTEGER NOT NULL DEFAULT 1,
  project        TEXT,
  user_scope     TEXT
);

CREATE INDEX IF NOT EXISTS idx_entities_canonical ON entities(canonical_name);
CREATE INDEX IF NOT EXISTS idx_entities_type      ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_user      ON entities(user_scope);

-- Entity relationships
CREATE TABLE IF NOT EXISTS entity_relations (
  id               TEXT   PRIMARY KEY,
  source_entity_id TEXT   NOT NULL,
  target_entity_id TEXT   NOT NULL,
  relation_type    TEXT   NOT NULL,
  context          TEXT,
  session_id       TEXT,
  created_at       BIGINT NOT NULL,
  CONSTRAINT fk_er_source FOREIGN KEY (source_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
  CONSTRAINT fk_er_target FOREIGN KEY (target_entity_id) REFERENCES entities(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_er_source ON entity_relations(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_er_target ON entity_relations(target_entity_id);

-- Junction table linking knowledge entries to entities
CREATE TABLE IF NOT EXISTS knowledge_entities (
  entry_id  TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY (entry_id, entity_id),
  CONSTRAINT fk_ke_entry  FOREIGN KEY (entry_id)  REFERENCES knowledge(id) ON DELETE CASCADE,
  CONSTRAINT fk_ke_entity FOREIGN KEY (entity_id) REFERENCES entities(id)  ON DELETE CASCADE
);

-- SVO Events table
CREATE TABLE IF NOT EXISTS events (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject    TEXT   NOT NULL,
  verb       TEXT   NOT NULL,
  object     TEXT   NOT NULL,
  start_date TEXT,
  end_date   TEXT,
  aliases    TEXT   NOT NULL DEFAULT '',
  category   TEXT   NOT NULL DEFAULT 'personal',
  session_id TEXT   NOT NULL,
  project    TEXT   NOT NULL DEFAULT '',
  timestamp  BIGINT NOT NULL DEFAULT 0,
  user_scope TEXT,
  tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(subject, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(verb, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(object, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(aliases, '')), 'D')
  ) STORED
);

CREATE INDEX IF NOT EXISTS idx_events_tsv     ON events USING GIN (tsv);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);

-- Evidence gap tracking
CREATE TABLE IF NOT EXISTS evidence_gaps (
  id               TEXT   PRIMARY KEY,
  query            TEXT   NOT NULL,
  tool             TEXT   NOT NULL,
  project          TEXT,
  user_scope       TEXT   NOT NULL DEFAULT 'default',
  result_count     INTEGER NOT NULL,
  top_score        REAL,
  top_confidence   REAL,
  occurred_at      BIGINT NOT NULL,
  resolved_at      BIGINT,
  resolution_id    TEXT,
  occurrence_count INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_gaps_project  ON evidence_gaps(project);
CREATE INDEX IF NOT EXISTS idx_gaps_user     ON evidence_gaps(user_scope);
CREATE INDEX IF NOT EXISTS idx_gaps_resolved ON evidence_gaps(resolved_at);
CREATE INDEX IF NOT EXISTS idx_gaps_occurred ON evidence_gaps(occurred_at);

-- Analytics events
CREATE TABLE IF NOT EXISTS analytics (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type TEXT   NOT NULL CHECK(event_type IN ('search','store','index','error','tool_call')),
  event_data TEXT,
  timestamp  BIGINT NOT NULL,
  session_id TEXT,
  project    TEXT,
  user_scope TEXT   NOT NULL DEFAULT 'default'
);

CREATE INDEX IF NOT EXISTS idx_analytics_type      ON analytics(event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_timestamp ON analytics(timestamp);

-- Quantization migration state
CREATE TABLE IF NOT EXISTS migration_state (
  id               TEXT    PRIMARY KEY DEFAULT 'quantization',
  current_bit_width INTEGER,
  target_bit_width  INTEGER,
  total_vectors     INTEGER DEFAULT 0,
  migrated_vectors  INTEGER DEFAULT 0,
  status            TEXT    DEFAULT 'idle',
  started_at        BIGINT,
  completed_at      BIGINT
);

-- Stored documents (user-uploaded PDFs, text files, images)
CREATE TABLE IF NOT EXISTS stored_documents (
  id          TEXT    PRIMARY KEY,
  title       TEXT    NOT NULL,
  mime_type   TEXT    NOT NULL,
  project     TEXT    NOT NULL DEFAULT 'global',
  user_scope  TEXT,
  tags        TEXT,
  chunk_count INTEGER NOT NULL,
  total_pages INTEGER,
  file_size   INTEGER,
  created_at  BIGINT  NOT NULL
);

-- Document chunks with multimodal embeddings
CREATE TABLE IF NOT EXISTS document_chunks (
  id          TEXT    PRIMARY KEY,
  document_id TEXT    NOT NULL REFERENCES stored_documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content     TEXT,
  embedding   BYTEA   NOT NULL,
  model       TEXT    NOT NULL DEFAULT 'gemini-embedding-2-preview',
  page_start  INTEGER,
  page_end    INTEGER,
  token_count INTEGER,
  format      TEXT    NOT NULL DEFAULT 'float32',
  created_at  BIGINT  NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(content, ''))
  ) STORED
);

CREATE INDEX IF NOT EXISTS idx_document_chunks_doc ON document_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_document_chunks_tsv ON document_chunks USING GIN (tsv);

-- Training data for local model distillation
CREATE TABLE IF NOT EXISTS training_data (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_type          TEXT   NOT NULL CHECK(task_type IN ('extraction', 'summarization', 'dialogue')),
  input_text         TEXT   NOT NULL,
  output_json        TEXT   NOT NULL,
  model_used         TEXT   NOT NULL,
  quality_score      REAL   NOT NULL DEFAULT 1.0,
  heuristic_diverged INTEGER NOT NULL DEFAULT 0,
  created_at         BIGINT NOT NULL,
  used_in_run        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_training_task    ON training_data(task_type, quality_score DESC);
CREATE INDEX IF NOT EXISTS idx_training_created ON training_data(created_at);
