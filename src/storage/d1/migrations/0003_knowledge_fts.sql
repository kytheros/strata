-- Migration 0003: Add FTS5 virtual table for knowledge full-text search.
--
-- Before this migration, D1KnowledgeStore.search() performed a full-table
-- LIKE scan that degrades past ~2-5K entries under D1's 30s CPU limit.
-- This migration creates a porter-stemmed FTS5 table with BM25 ranking,
-- adds insert/delete/update sync triggers, and backfills existing rows.

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  summary,
  details,
  tags,
  content=knowledge,
  content_rowid=rowid,
  tokenize='porter'
);

-- Sync triggers keep knowledge_fts up to date with the knowledge table.
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

-- Backfill existing knowledge rows into the FTS index.
INSERT INTO knowledge_fts(rowid, summary, details, tags)
  SELECT rowid, summary, details, COALESCE(tags, '') FROM knowledge;

-- Bump schema version.
INSERT OR REPLACE INTO index_meta(key, value) VALUES ('schema_version', '3');
