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

    -- Stored documents (user-uploaded PDFs, text files, images)
    CREATE TABLE IF NOT EXISTS stored_documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT 'global',
      user TEXT,
      tags TEXT,
      chunk_count INTEGER NOT NULL,
      total_pages INTEGER,
      file_size INTEGER,
      created_at INTEGER NOT NULL
    );

    -- Document chunks with multimodal embeddings
    CREATE TABLE IF NOT EXISTS document_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES stored_documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      content TEXT,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL DEFAULT 'gemini-embedding-2-preview',
      page_start INTEGER,
      page_end INTEGER,
      token_count INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_document_chunks_doc ON document_chunks(document_id);

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

  // Add format column to embeddings table (quantization support)
  const hasFormatEmbed = db.prepare(
    "SELECT 1 FROM pragma_table_info('embeddings') WHERE name = 'format'"
  ).get();
  if (!hasFormatEmbed) {
    db.exec("ALTER TABLE embeddings ADD COLUMN format TEXT NOT NULL DEFAULT 'float32'");
  }

  // Add format column to document_chunks table if it exists
  const hasDocChunks = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_chunks'"
  ).get();
  if (hasDocChunks) {
    const hasFormatChunks = db.prepare(
      "SELECT 1 FROM pragma_table_info('document_chunks') WHERE name = 'format'"
    ).get();
    if (!hasFormatChunks) {
      db.exec("ALTER TABLE document_chunks ADD COLUMN format TEXT NOT NULL DEFAULT 'float32'");
    }
  }

  // Training data for local model distillation
  db.exec(`
    CREATE TABLE IF NOT EXISTS training_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_type TEXT NOT NULL CHECK(task_type IN ('extraction', 'summarization', 'dialogue', 'conflict')),
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

  // Migrate existing training_data tables that lack the 'dialogue' task type OR
  // the 'conflict' task type (Phase 0 distillation capture expansion).
  const trainingSql = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='training_data'"
  ).get() as { sql: string } | undefined;
  if (
    trainingSql &&
    (!trainingSql.sql.includes("'dialogue'") || !trainingSql.sql.includes("'conflict'"))
  ) {
    db.pragma("foreign_keys = OFF");
    const migrateTraining = db.transaction(() => {
      db.exec(`
        CREATE TABLE training_data_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_type TEXT NOT NULL CHECK(task_type IN ('extraction', 'summarization', 'dialogue', 'conflict')),
          input_text TEXT NOT NULL,
          output_json TEXT NOT NULL,
          model_used TEXT NOT NULL,
          quality_score REAL NOT NULL DEFAULT 1.0,
          heuristic_diverged INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          used_in_run INTEGER
        );
        INSERT INTO training_data_new (id, task_type, input_text, output_json, model_used, quality_score, heuristic_diverged, created_at, used_in_run)
        SELECT id, task_type, input_text, output_json, model_used, quality_score, heuristic_diverged, created_at, used_in_run FROM training_data;
        DROP TABLE training_data;
        ALTER TABLE training_data_new RENAME TO training_data;
        CREATE INDEX IF NOT EXISTS idx_training_task ON training_data(task_type, quality_score DESC);
        CREATE INDEX IF NOT EXISTS idx_training_created ON training_data(created_at);
      `);
    });
    migrateTraining();
    db.pragma("foreign_keys = ON");
  }

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

  // FTS5 virtual table for knowledge entries
  const knowledgeFtsExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_fts'"
  ).get();

  if (!knowledgeFtsExists) {
    db.exec(`
      CREATE VIRTUAL TABLE knowledge_fts USING fts5(
        summary,
        details,
        tags,
        content=knowledge,
        content_rowid=rowid,
        tokenize='porter unicode61'
      );
    `);
  }

  // Triggers to keep knowledge_fts in sync with knowledge table
  const knowledgeTriggerExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name='knowledge_ai'"
  ).get();

  if (!knowledgeTriggerExists) {
    db.exec(`
      -- After insert: add to knowledge FTS
      CREATE TRIGGER knowledge_ai AFTER INSERT ON knowledge BEGIN
        INSERT INTO knowledge_fts(rowid, summary, details, tags)
          VALUES (new.rowid, new.summary, new.details, COALESCE(new.tags, ''));
      END;

      -- After delete: remove from knowledge FTS
      CREATE TRIGGER knowledge_ad AFTER DELETE ON knowledge BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, summary, details, tags)
          VALUES('delete', old.rowid, old.summary, old.details, COALESCE(old.tags, ''));
      END;

      -- After update: update knowledge FTS
      CREATE TRIGGER knowledge_au AFTER UPDATE ON knowledge BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, summary, details, tags)
          VALUES('delete', old.rowid, old.summary, old.details, COALESCE(old.tags, ''));
        INSERT INTO knowledge_fts(rowid, summary, details, tags)
          VALUES (new.rowid, new.summary, new.details, COALESCE(new.tags, ''));
      END;
    `);
  }

  // SVO Events table — structured Subject-Verb-Object event extraction
  // Events bridge vocabulary gaps via lexical aliases indexed in FTS5
  const eventsExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='events'"
  ).get();
  if (!eventsExists) {
    db.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject TEXT NOT NULL,
        verb TEXT NOT NULL,
        object TEXT NOT NULL,
        start_date TEXT,
        end_date TEXT,
        aliases TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'personal',
        session_id TEXT NOT NULL,
        project TEXT NOT NULL DEFAULT '',
        timestamp INTEGER NOT NULL DEFAULT 0,
        user TEXT
      );

      CREATE VIRTUAL TABLE events_fts USING fts5(
        subject,
        verb,
        object,
        aliases,
        content=events,
        content_rowid=id,
        tokenize='porter unicode61'
      );

      CREATE TRIGGER events_ai AFTER INSERT ON events BEGIN
        INSERT INTO events_fts(rowid, subject, verb, object, aliases)
          VALUES (new.id, new.subject, new.verb, new.object, new.aliases);
      END;

      CREATE TRIGGER events_ad AFTER DELETE ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, subject, verb, object, aliases)
          VALUES ('delete', old.id, old.subject, old.verb, old.object, old.aliases);
      END;
    `);
  }

  // FTS5 virtual table for document chunk text search
  // Migration: contentless → content-storing so columns are retrievable for search JOINs.
  // The original contentless version stored terms for MATCH but returned null for all columns,
  // making it impossible to JOIN with document_chunks/stored_documents.
  const docChunksFtsExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='document_chunks_fts'"
  ).get();

  if (docChunksFtsExists) {
    // Check if the existing table is contentless (has no retrievable column values).
    // If so, drop and recreate with content-storing FTS5.
    const testRow = db.prepare(
      "SELECT document_id FROM document_chunks_fts LIMIT 1"
    ).get() as any;
    if (testRow && testRow.document_id === null) {
      // Contentless FTS5 — drop and recreate
      db.exec("DROP TABLE document_chunks_fts");
      db.exec(`
        CREATE VIRTUAL TABLE document_chunks_fts USING fts5(
          content,
          document_id UNINDEXED,
          chunk_id UNINDEXED,
          project UNINDEXED,
          tokenize='porter unicode61'
        );
      `);
      // Backfill from document_chunks
      const existingChunks = db.prepare(`
        SELECT dc.content, dc.document_id, dc.id as chunk_id, sd.project
        FROM document_chunks dc
        JOIN stored_documents sd ON sd.id = dc.document_id
        WHERE dc.content IS NOT NULL
      `).all() as any[];
      if (existingChunks.length > 0) {
        const insertFts = db.prepare(
          "INSERT INTO document_chunks_fts (content, document_id, chunk_id, project) VALUES (?, ?, ?, ?)"
        );
        for (const row of existingChunks) {
          insertFts.run(row.content, row.document_id, row.chunk_id, row.project);
        }
      }
    }
  } else {
    db.exec(`
      CREATE VIRTUAL TABLE document_chunks_fts USING fts5(
        content,
        document_id UNINDEXED,
        chunk_id UNINDEXED,
        project UNINDEXED,
        tokenize='porter unicode61'
      );
    `);
  }

  // ── Migration 0004: knowledge_turns (Turn Isolation Retrieval) ─────────────
  // Additive. Does not alter knowledge or knowledge_fts.

  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_turns (
      turn_id      TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL,
      project      TEXT,
      user_id      TEXT,
      speaker      TEXT NOT NULL,
      content      TEXT NOT NULL,
      message_index INTEGER NOT NULL,
      created_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_turns_session ON knowledge_turns(session_id, message_index);
    CREATE INDEX IF NOT EXISTS idx_knowledge_turns_project ON knowledge_turns(project, created_at DESC);
  `);

  const knowledgeTurnsFtsExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_turns_fts'"
  ).get();

  if (!knowledgeTurnsFtsExists) {
    db.exec(`
      CREATE VIRTUAL TABLE knowledge_turns_fts USING fts5(
        content,
        content='knowledge_turns',
        content_rowid='rowid',
        tokenize='porter'
      );
    `);
  }

  const knowledgeTurnsTriggerExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name='knowledge_turns_ai'"
  ).get();

  if (!knowledgeTurnsTriggerExists) {
    db.exec(`
      CREATE TRIGGER knowledge_turns_ai AFTER INSERT ON knowledge_turns BEGIN
        INSERT INTO knowledge_turns_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TRIGGER knowledge_turns_ad AFTER DELETE ON knowledge_turns BEGIN
        INSERT INTO knowledge_turns_fts(knowledge_turns_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
    `);
  }

  // Backfill knowledge_fts if it exists but is empty while knowledge has rows
  backfillKnowledgeFts(db);
}

/**
 * Backfill knowledge_fts from existing knowledge rows.
 * Runs once on upgrade: if knowledge_fts exists but is empty and knowledge has rows,
 * populates the FTS index. No-ops if already populated or if knowledge is empty.
 */
function backfillKnowledgeFts(db: Database.Database): void {
  const ftsExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_fts'"
  ).get();
  if (!ftsExists) return;

  const ftsCount = (db.prepare(
    "SELECT COUNT(*) as c FROM knowledge_fts"
  ).get() as { c: number }).c;

  const knowledgeCount = (db.prepare(
    "SELECT COUNT(*) as c FROM knowledge"
  ).get() as { c: number }).c;

  if (ftsCount === 0 && knowledgeCount > 0) {
    db.exec(`
      INSERT INTO knowledge_fts(rowid, summary, details, tags)
        SELECT rowid, summary, details, COALESCE(tags, '') FROM knowledge
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
