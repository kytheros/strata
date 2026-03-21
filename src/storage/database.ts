/**
 * SQLite database manager for Strata.
 * Creates and manages the SQLite database with FTS5 for full-text search.
 */

import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import Database from "better-sqlite3";
import { computeImportance } from "../knowledge/importance.js";

/** Default data directory */
const DEFAULT_DATA_DIR = join(homedir(), ".strata");

/** Get the configured data directory */
export function getDataDir(): string {
  return process.env.STRATA_DATA_DIR || DEFAULT_DATA_DIR;
}

/** Get the database file path */
export function getDbPath(): string {
  return join(getDataDir(), "strata.db");
}

/**
 * Open or create a SQLite database with the full Strata schema.
 * Pass ":memory:" for in-memory databases (tests).
 */
export function openDatabase(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? getDbPath();

  // Ensure directory exists for file-based databases
  if (resolvedPath !== ":memory:") {
    const dir = dirname(resolvedPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(resolvedPath);

  // Enable WAL mode for concurrent read access
  db.pragma("journal_mode = WAL");
  // Performance pragmas
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  // Allow concurrent access from multiple MCP server processes (e.g., Claude Code + Gemini CLI)
  db.pragma("busy_timeout = 5000");

  // Create schema
  initSchema(db);

  // Backfill importance scores for existing entries (one-time on upgrade)
  backfillImportance(db);

  return db;
}

/**
 * Initialize the database schema (idempotent — uses IF NOT EXISTS).
 */
function initSchema(db: Database.Database): void {
  db.exec(`
    -- Core document chunks (replaces DocumentStore + BM25Index + TFIDFIndex)
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      tool TEXT NOT NULL DEFAULT 'claude-code',
      text TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'mixed')),
      timestamp INTEGER NOT NULL,
      tool_names TEXT,
      token_count INTEGER NOT NULL,
      message_index INTEGER NOT NULL,
      user TEXT NOT NULL DEFAULT 'default'
    );

    -- Knowledge entries (replaces knowledge.json)
    CREATE TABLE IF NOT EXISTS knowledge (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('decision','solution','error_fix','pattern','learning','procedure','fact','preference','episodic')),
      project TEXT NOT NULL,
      session_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      summary TEXT NOT NULL,
      details TEXT NOT NULL,
      tags TEXT,
      related_files TEXT,
      occurrences INTEGER,
      project_count INTEGER,
      extracted_at INTEGER,
      updated_at INTEGER,
      user TEXT NOT NULL DEFAULT 'default'
    );

    -- Session summaries (replaces summaries/*.json files)
    CREATE TABLE IF NOT EXISTS summaries (
      session_id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      tool TEXT NOT NULL DEFAULT 'claude-code',
      topic TEXT NOT NULL,
      start_time INTEGER NOT NULL,
      end_time INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      tools_used TEXT,
      data TEXT NOT NULL
    );

    -- Index metadata (replaces meta.json)
    CREATE TABLE IF NOT EXISTS index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_documents_session ON documents(session_id);
    CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project);
    CREATE INDEX IF NOT EXISTS idx_documents_tool ON documents(tool);
    CREATE INDEX IF NOT EXISTS idx_documents_timestamp ON documents(timestamp);
    CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge(project);
    CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge(type);
    CREATE INDEX IF NOT EXISTS idx_summaries_project ON summaries(project);

    -- Analytics events (Phase 2D: local-only usage tracking)
    CREATE TABLE IF NOT EXISTS analytics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL CHECK(event_type IN ('search', 'tool_use', 'knowledge_access', 'session_index')),
      event_data TEXT NOT NULL,
      project TEXT,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_analytics_type ON analytics(event_type);
    CREATE INDEX IF NOT EXISTS idx_analytics_timestamp ON analytics(timestamp);

    -- Embeddings for vector search (Float32Array serialized as BLOB)
    CREATE TABLE IF NOT EXISTS embeddings (
      entry_id TEXT PRIMARY KEY,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_embeddings_entry ON embeddings(entry_id);

    -- Entity tracking: named entities extracted from knowledge entries
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      canonical_name TEXT NOT NULL,
      aliases TEXT,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      mention_count INTEGER NOT NULL DEFAULT 1,
      project TEXT,
      user TEXT
    );

    -- Entity relationships (e.g., replaced_by, used_for, depends_on, co_occurs)
    CREATE TABLE IF NOT EXISTS entity_relations (
      id TEXT PRIMARY KEY,
      source_entity_id TEXT NOT NULL REFERENCES entities(id),
      target_entity_id TEXT NOT NULL REFERENCES entities(id),
      relation_type TEXT NOT NULL,
      context TEXT,
      session_id TEXT,
      created_at INTEGER NOT NULL
    );

    -- Junction table linking knowledge entries to entities
    CREATE TABLE IF NOT EXISTS knowledge_entities (
      entry_id TEXT NOT NULL REFERENCES knowledge(id),
      entity_id TEXT NOT NULL REFERENCES entities(id),
      PRIMARY KEY (entry_id, entity_id)
    );

    CREATE INDEX IF NOT EXISTS idx_entities_canonical ON entities(canonical_name);
    CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
    CREATE INDEX IF NOT EXISTS idx_entity_relations_source ON entity_relations(source_entity_id);
    CREATE INDEX IF NOT EXISTS idx_entity_relations_target ON entity_relations(target_entity_id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_entities_entity ON knowledge_entities(entity_id);

    -- Knowledge mutation history (audit trail for add/update/delete)
    CREATE TABLE IF NOT EXISTS knowledge_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id TEXT NOT NULL,
      old_summary TEXT,
      new_summary TEXT,
      old_details TEXT,
      new_details TEXT,
      event TEXT NOT NULL CHECK(event IN ('add','update','delete')),
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_history_entry ON knowledge_history(entry_id, id DESC);
  `);

  // ── Migrations for existing databases ──────────────────────────────

  // Migration: add user column to documents table
  const hasUserDoc = db.prepare(
    "SELECT 1 FROM pragma_table_info('documents') WHERE name = 'user'"
  ).get();
  if (!hasUserDoc) {
    db.exec("ALTER TABLE documents ADD COLUMN user TEXT NOT NULL DEFAULT 'default'");
    db.exec("CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user)");
  }

  // Migration: add user column to entities table
  const hasUserEntity = db.prepare(
    "SELECT 1 FROM pragma_table_info('entities') WHERE name = 'user'"
  ).get();
  if (!hasUserEntity) {
    try {
      db.exec("ALTER TABLE entities ADD COLUMN user TEXT");
    } catch (e: unknown) {
      // Ignore if column already exists (race with CREATE TABLE IF NOT EXISTS)
      if (!(e instanceof Error && e.message.includes("duplicate column"))) throw e;
    }
  }

  // Migration: recreate knowledge table if CHECK constraint is outdated (missing 'fact' type)
  // or if user column is missing. This handles both type expansion and user scoping.
  const knowledgeSql = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge'"
  ).get() as { sql: string } | undefined;

  if (knowledgeSql && !knowledgeSql.sql.includes("'fact'")) {
    // Detect existing columns
    const columns = (db.prepare("SELECT name FROM pragma_table_info('knowledge')").all() as { name: string }[])
      .map((r) => r.name);
    const hasUpdatedAt = columns.includes("updated_at");
    const hasUser = columns.includes("user");

    // Build the SELECT expression to copy data into the new schema
    const baseCols = "id, type, project, session_id, timestamp, summary, details, tags, related_files, occurrences, project_count, extracted_at";
    const updatedAtExpr = hasUpdatedAt ? "updated_at" : "NULL";
    const userExpr = hasUser ? "user" : "'default'";
    const selectSql = `SELECT ${baseCols}, ${updatedAtExpr}, ${userExpr} FROM knowledge`;

    const countBefore = (db.prepare("SELECT COUNT(*) as c FROM knowledge").get() as { c: number }).c;

    db.pragma("foreign_keys = OFF");
    const migrate = db.transaction(() => {
      db.exec(`
        CREATE TABLE knowledge_new (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK(type IN ('decision','solution','error_fix','pattern','learning','procedure','fact','preference','episodic')),
          project TEXT NOT NULL,
          session_id TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          summary TEXT NOT NULL,
          details TEXT NOT NULL,
          tags TEXT,
          related_files TEXT,
          occurrences INTEGER,
          project_count INTEGER,
          extracted_at INTEGER,
          updated_at INTEGER,
          user TEXT NOT NULL DEFAULT 'default'
        );
        INSERT INTO knowledge_new (id, type, project, session_id, timestamp, summary, details, tags, related_files, occurrences, project_count, extracted_at, updated_at, user)
        ${selectSql};
      `);

      const countAfter = (db.prepare("SELECT COUNT(*) as c FROM knowledge_new").get() as { c: number }).c;
      if (countAfter !== countBefore) {
        throw new Error(`Knowledge migration row count mismatch: ${countBefore} → ${countAfter}`);
      }

      db.exec("DROP TABLE knowledge");
      db.exec("ALTER TABLE knowledge_new RENAME TO knowledge");
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge(project);
        CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge(type);
        CREATE INDEX IF NOT EXISTS idx_knowledge_user ON knowledge(user);
        CREATE INDEX IF NOT EXISTS idx_knowledge_history_entry ON knowledge_history(entry_id, id DESC);
      `);
    });
    migrate();
    db.pragma("foreign_keys = ON");
  } else {
    // For databases with the new CHECK but possibly missing columns
    const hasUpdatedAt = db.prepare(
      "SELECT 1 FROM pragma_table_info('knowledge') WHERE name = 'updated_at'"
    ).get();
    if (!hasUpdatedAt) {
      db.exec("ALTER TABLE knowledge ADD COLUMN updated_at INTEGER");
    }
    const hasUserKnowledge = db.prepare(
      "SELECT 1 FROM pragma_table_info('knowledge') WHERE name = 'user'"
    ).get();
    if (!hasUserKnowledge) {
      db.exec("ALTER TABLE knowledge ADD COLUMN user TEXT NOT NULL DEFAULT 'default'");
      db.exec("CREATE INDEX IF NOT EXISTS idx_knowledge_user ON knowledge(user)");
    }
  }

  // Ensure user indexes exist (safe to run after all migrations)
  db.exec("CREATE INDEX IF NOT EXISTS idx_knowledge_user ON knowledge(user)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user)");

  // Migration: add importance column to knowledge table
  const hasImportanceKnowledge = db.prepare(
    "SELECT 1 FROM pragma_table_info('knowledge') WHERE name = 'importance'"
  ).get();
  if (!hasImportanceKnowledge) {
    db.exec("ALTER TABLE knowledge ADD COLUMN importance REAL");
  }

  // Migration: add importance column to documents table
  const hasImportanceDocuments = db.prepare(
    "SELECT 1 FROM pragma_table_info('documents') WHERE name = 'importance'"
  ).get();
  if (!hasImportanceDocuments) {
    db.exec("ALTER TABLE documents ADD COLUMN importance REAL");
  }

  // Training data for local model distillation
  db.exec(`
    CREATE TABLE IF NOT EXISTS training_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_type TEXT NOT NULL CHECK(task_type IN ('extraction', 'summarization')),
      input_text TEXT NOT NULL,
      output_json TEXT NOT NULL,
      model_used TEXT NOT NULL,
      quality_score REAL NOT NULL DEFAULT 1.0,
      heuristic_diverged INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      used_in_run INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_training_task ON training_data(task_type, quality_score DESC);
    CREATE INDEX IF NOT EXISTS idx_training_created ON training_data(created_at);
  `);

  // Evidence gap tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS evidence_gaps (
      id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      tool TEXT NOT NULL,
      project TEXT,
      user TEXT NOT NULL DEFAULT 'default',
      result_count INTEGER NOT NULL,
      top_score REAL,
      top_confidence REAL,
      occurred_at INTEGER NOT NULL,
      resolved_at INTEGER,
      resolution_id TEXT,
      occurrence_count INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_gaps_project ON evidence_gaps(project);
    CREATE INDEX IF NOT EXISTS idx_gaps_user ON evidence_gaps(user);
    CREATE INDEX IF NOT EXISTS idx_gaps_resolved ON evidence_gaps(resolved_at);
    CREATE INDEX IF NOT EXISTS idx_gaps_occurred ON evidence_gaps(occurred_at);
  `);

  // FTS5 virtual table — separate exec because it can't use IF NOT EXISTS in all SQLite versions
  const ftsExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='documents_fts'"
  ).get();

  if (!ftsExists) {
    db.exec(`
      CREATE VIRTUAL TABLE documents_fts USING fts5(
        text,
        content=documents,
        content_rowid=rowid,
        tokenize='porter unicode61'
      );
    `);
  }

  // Triggers to keep FTS in sync with documents table
  const triggerExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name='documents_ai'"
  ).get();

  if (!triggerExists) {
    db.exec(`
      -- After insert: add to FTS
      CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
        INSERT INTO documents_fts(rowid, text) VALUES (new.rowid, new.text);
      END;

      -- After delete: remove from FTS
      CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
        INSERT INTO documents_fts(documents_fts, rowid, text) VALUES('delete', old.rowid, old.text);
      END;

      -- After update: update FTS
      CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
        INSERT INTO documents_fts(documents_fts, rowid, text) VALUES('delete', old.rowid, old.text);
        INSERT INTO documents_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
    `);
  }
}

/**
 * Backfill importance scores for existing entries that have NULL importance.
 * Runs in batches of 500 inside transactions for efficiency.
 * Called once after schema migrations on startup; no-ops if nothing to backfill.
 */
function backfillImportance(db: Database.Database): void {
  const BATCH_SIZE = 500;

  // Check if any knowledge rows need backfill
  const hasNullKnowledge = db.prepare(
    "SELECT 1 FROM knowledge WHERE importance IS NULL LIMIT 1"
  ).get();

  if (hasNullKnowledge) {
    let offset = 0;
    while (true) {
      const batch = db.prepare(
        `SELECT id, type, summary, details, session_id, occurrences, project_count
         FROM knowledge WHERE importance IS NULL LIMIT ? OFFSET ?`
      ).all(BATCH_SIZE, offset) as {
        id: string;
        type: string;
        summary: string;
        details: string;
        session_id: string;
        occurrences: number | null;
        project_count: number | null;
      }[];

      if (batch.length === 0) break;

      const update = db.prepare(
        "UPDATE knowledge SET importance = ? WHERE id = ?"
      );
      const tx = db.transaction(() => {
        for (const row of batch) {
          const score = computeImportance({
            text: `${row.summary} ${row.details}`,
            sessionId: row.session_id,
            knowledgeType: row.type as import("../knowledge/knowledge-store.js").KnowledgeType,
            occurrences: row.occurrences ?? undefined,
            projectCount: row.project_count ?? undefined,
          });
          update.run(score, row.id);
        }
      });
      tx();
      offset += BATCH_SIZE;
    }
  }

  // Check if any document rows need backfill
  const hasNullDocuments = db.prepare(
    "SELECT 1 FROM documents WHERE importance IS NULL LIMIT 1"
  ).get();

  if (hasNullDocuments) {
    let offset = 0;
    while (true) {
      const batch = db.prepare(
        `SELECT id, text, role, session_id
         FROM documents WHERE importance IS NULL LIMIT ? OFFSET ?`
      ).all(BATCH_SIZE, offset) as {
        id: string;
        text: string;
        role: "user" | "assistant" | "mixed";
        session_id: string;
      }[];

      if (batch.length === 0) break;

      const update = db.prepare(
        "UPDATE documents SET importance = ? WHERE id = ?"
      );
      const tx = db.transaction(() => {
        for (const row of batch) {
          const score = computeImportance({
            text: row.text,
            role: row.role,
            sessionId: row.session_id,
          });
          update.run(score, row.id);
        }
      });
      tx();
      offset += BATCH_SIZE;
    }
  }
}
