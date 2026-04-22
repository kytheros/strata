/**
 * D1 schema definition.
 *
 * Exports the full CREATE TABLE SQL for the Strata D1 database.
 * This is the same schema as the SQLite adapter but formatted for D1 migration.
 * All 13 tables, indexes, FTS5 virtual table with triggers, CHECK constraints,
 * and foreign keys.
 */

/**
 * Complete D1 schema SQL. Run via `db.exec(D1_SCHEMA)` for programmatic init
 * or apply as a migration via `wrangler d1 migrations apply`.
 */
export const D1_SCHEMA = `
-- Core document chunks
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  tool TEXT NOT NULL DEFAULT 'claude-code',
  text TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'mixed')),
  timestamp INTEGER NOT NULL,
  tool_names TEXT,
  token_count INTEGER NOT NULL DEFAULT 0,
  message_index INTEGER NOT NULL DEFAULT 0,
  user TEXT NOT NULL DEFAULT 'default',
  importance REAL
);
CREATE INDEX IF NOT EXISTS idx_documents_session ON documents(session_id);
CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user);
CREATE INDEX IF NOT EXISTS idx_documents_timestamp ON documents(timestamp);

-- FTS5 full-text search on document text
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  text,
  content=documents,
  content_rowid=rowid,
  tokenize='porter'
);

-- FTS5 sync triggers
CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO documents_fts(rowid, text) VALUES (new.rowid, new.text);
END;

-- Knowledge entries
CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('decision','solution','error_fix','pattern','learning','procedure','fact','preference','episodic')),
  project TEXT NOT NULL,
  session_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  summary TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  tags TEXT,
  related_files TEXT,
  occurrences INTEGER DEFAULT 1,
  project_count INTEGER DEFAULT 1,
  extracted_at INTEGER,
  updated_at INTEGER,
  user TEXT NOT NULL DEFAULT 'default',
  importance REAL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge(project);
CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge(type);
CREATE INDEX IF NOT EXISTS idx_knowledge_user ON knowledge(user);
CREATE INDEX IF NOT EXISTS idx_knowledge_timestamp ON knowledge(timestamp);

-- FTS5 full-text search on knowledge entries
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  summary,
  details,
  tags,
  content=knowledge,
  content_rowid=rowid,
  tokenize='porter'
);

-- FTS5 sync triggers
CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge BEGIN
  INSERT INTO knowledge_fts(rowid, summary, details, tags) VALUES (new.rowid, new.summary, new.details, COALESCE(new.tags, ''));
END;
CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, summary, details, tags) VALUES ('delete', old.rowid, old.summary, old.details, COALESCE(old.tags, ''));
END;
CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, summary, details, tags) VALUES ('delete', old.rowid, old.summary, old.details, COALESCE(old.tags, ''));
  INSERT INTO knowledge_fts(rowid, summary, details, tags) VALUES (new.rowid, new.summary, new.details, COALESCE(new.tags, ''));
END;

-- Knowledge mutation history (audit trail)
CREATE TABLE IF NOT EXISTS knowledge_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id TEXT NOT NULL,
  old_summary TEXT,
  new_summary TEXT,
  old_details TEXT,
  new_details TEXT,
  event TEXT NOT NULL CHECK(event IN ('add','update','delete')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (entry_id) REFERENCES knowledge(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_kh_entry ON knowledge_history(entry_id);

-- Session summaries
CREATE TABLE IF NOT EXISTS summaries (
  session_id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  tool TEXT NOT NULL DEFAULT 'claude-code',
  topic TEXT NOT NULL DEFAULT '',
  start_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  tools_used TEXT,
  data TEXT NOT NULL,
  user TEXT NOT NULL DEFAULT 'default'
);
CREATE INDEX IF NOT EXISTS idx_summaries_project ON summaries(project);
CREATE INDEX IF NOT EXISTS idx_summaries_end_time ON summaries(end_time);
CREATE INDEX IF NOT EXISTS idx_summaries_user ON summaries(user);

-- Index metadata (key-value store)
CREATE TABLE IF NOT EXISTS index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Embeddings for vector search (Float32Array serialized as BLOB)
CREATE TABLE IF NOT EXISTS embeddings (
  id TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL DEFAULT 'gemini-embedding-001',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  format TEXT NOT NULL DEFAULT 'float32'
);

-- Entity tracking
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  aliases TEXT DEFAULT '[]',
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  mention_count INTEGER NOT NULL DEFAULT 1,
  project TEXT,
  user TEXT
);
CREATE INDEX IF NOT EXISTS idx_entities_canonical ON entities(canonical_name);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_user ON entities(user);

-- Entity relationships
CREATE TABLE IF NOT EXISTS entity_relations (
  id TEXT PRIMARY KEY,
  source_entity_id TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  context TEXT,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (source_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
  FOREIGN KEY (target_entity_id) REFERENCES entities(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_er_source ON entity_relations(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_er_target ON entity_relations(target_entity_id);

-- Junction table linking knowledge entries to entities
CREATE TABLE IF NOT EXISTS knowledge_entities (
  entry_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY (entry_id, entity_id),
  FOREIGN KEY (entry_id) REFERENCES knowledge(id) ON DELETE CASCADE,
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
);

-- Evidence gap tracking
CREATE TABLE IF NOT EXISTS evidence_gaps (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  context TEXT,
  gap_type TEXT NOT NULL DEFAULT 'no_results',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT
);

-- Analytics events
CREATE TABLE IF NOT EXISTS analytics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK(event_type IN ('search','store','index','error','tool_call')),
  event_data TEXT,
  timestamp INTEGER NOT NULL,
  session_id TEXT,
  project TEXT,
  user TEXT NOT NULL DEFAULT 'default'
);
CREATE INDEX IF NOT EXISTS idx_analytics_type ON analytics(event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_timestamp ON analytics(timestamp);

-- Quantization migration state
CREATE TABLE IF NOT EXISTS migration_state (
  id TEXT PRIMARY KEY DEFAULT 'quantization',
  current_bit_width INTEGER,
  target_bit_width INTEGER,
  total_vectors INTEGER DEFAULT 0,
  migrated_vectors INTEGER DEFAULT 0,
  status TEXT DEFAULT 'idle',
  started_at INTEGER,
  completed_at INTEGER
);
`;

/** Schema version for tracking migrations. */
export const D1_SCHEMA_VERSION = "3";
