import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";

describe("openDatabase", () => {
  let db: Database.Database;

  afterEach(() => {
    if (db) db.close();
  });

  it("should create an in-memory database", () => {
    db = openDatabase(":memory:");
    expect(db.open).toBe(true);
  });

  it("should enable WAL mode", () => {
    db = openDatabase(":memory:");
    const result = db.pragma("journal_mode") as { journal_mode: string }[];
    // In-memory databases may report 'memory' instead of 'wal'
    expect(["wal", "memory"]).toContain(result[0].journal_mode);
  });

  it("should create documents table", () => {
    db = openDatabase(":memory:");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='documents'")
      .get();
    expect(tables).toBeDefined();
  });

  it("should create documents_fts virtual table", () => {
    db = openDatabase(":memory:");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='documents_fts'")
      .get();
    expect(tables).toBeDefined();
  });

  it("should create knowledge table", () => {
    db = openDatabase(":memory:");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge'")
      .get();
    expect(tables).toBeDefined();
  });

  it("should create summaries table", () => {
    db = openDatabase(":memory:");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='summaries'")
      .get();
    expect(tables).toBeDefined();
  });

  it("should create index_meta table", () => {
    db = openDatabase(":memory:");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='index_meta'")
      .get();
    expect(tables).toBeDefined();
  });

  it("should create all expected indexes", () => {
    db = openDatabase(":memory:");
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all() as { name: string }[];
    const indexNames = indexes.map((i) => i.name);

    expect(indexNames).toContain("idx_documents_session");
    expect(indexNames).toContain("idx_documents_project");
    expect(indexNames).toContain("idx_documents_tool");
    expect(indexNames).toContain("idx_documents_timestamp");
    expect(indexNames).toContain("idx_knowledge_project");
    expect(indexNames).toContain("idx_knowledge_type");
    expect(indexNames).toContain("idx_summaries_project");
  });

  it("should create FTS sync triggers", () => {
    db = openDatabase(":memory:");
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
      .all() as { name: string }[];
    const triggerNames = triggers.map((t) => t.name);

    expect(triggerNames).toContain("documents_ai");
    expect(triggerNames).toContain("documents_ad");
    expect(triggerNames).toContain("documents_au");
  });

  it("should enforce role CHECK constraint on documents", () => {
    db = openDatabase(":memory:");
    expect(() => {
      db.prepare(`
        INSERT INTO documents (id, session_id, project, text, role, timestamp, token_count, message_index)
        VALUES ('test', 'sess1', 'proj1', 'hello', 'invalid_role', 0, 5, 0)
      `).run();
    }).toThrow();
  });

  it("should enforce type CHECK constraint on knowledge", () => {
    db = openDatabase(":memory:");
    expect(() => {
      db.prepare(`
        INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details)
        VALUES ('test', 'invalid_type', 'proj1', 'sess1', 0, 'summary', 'details')
      `).run();
    }).toThrow();
  });

  it("should create stored_documents table", () => {
    db = openDatabase(":memory:");
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stored_documents'")
      .get();
    expect(table).toBeDefined();
  });

  it("should create document_chunks table", () => {
    db = openDatabase(":memory:");
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='document_chunks'")
      .get();
    expect(table).toBeDefined();
  });

  it("should create document_chunks_fts virtual table", () => {
    db = openDatabase(":memory:");
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='document_chunks_fts'")
      .get();
    expect(table).toBeDefined();
  });

  it("should be idempotent (can open twice without error)", () => {
    db = openDatabase(":memory:");
    // Opening schema init again should not throw
    expect(() => openDatabase(":memory:")).not.toThrow();
  });

  // ── migration 0004 ────────────────────────────────────────────────────────

  describe("migration 0004 — knowledge_turns", () => {
    it("creates knowledge_turns table", () => {
      db = openDatabase(":memory:");
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_turns'")
        .get();
      expect(table).toBeDefined();
    });

    it("creates knowledge_turns_fts virtual table with porter tokenizer", () => {
      db = openDatabase(":memory:");
      const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_turns_fts'")
        .get() as { sql: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.sql).toContain("fts5");
      expect(row!.sql).toContain("porter");
    });

    it("creates idx_knowledge_turns_session index", () => {
      db = openDatabase(":memory:");
      const idx = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_knowledge_turns_session'"
        )
        .get();
      expect(idx).toBeDefined();
    });

    it("creates idx_knowledge_turns_project index", () => {
      db = openDatabase(":memory:");
      const idx = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_knowledge_turns_project'"
        )
        .get();
      expect(idx).toBeDefined();
    });

    it("creates knowledge_turns_ai insert trigger", () => {
      db = openDatabase(":memory:");
      const trig = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name='knowledge_turns_ai'"
        )
        .get();
      expect(trig).toBeDefined();
    });

    it("creates knowledge_turns_ad delete trigger", () => {
      db = openDatabase(":memory:");
      const trig = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name='knowledge_turns_ad'"
        )
        .get();
      expect(trig).toBeDefined();
    });

    it("insert trigger keeps knowledge_turns_fts in sync", () => {
      db = openDatabase(":memory:");
      db.prepare(`
        INSERT INTO knowledge_turns (turn_id, session_id, speaker, content, message_index, created_at)
        VALUES ('t1', 'sess1', 'user', 'TypeScript generics explained', 0, 1000)
      `).run();

      const result = db
        .prepare("SELECT rowid FROM knowledge_turns_fts WHERE knowledge_turns_fts MATCH 'typescript'")
        .all() as { rowid: number }[];
      expect(result.length).toBe(1);
    });

    it("delete trigger removes entry from knowledge_turns_fts", () => {
      db = openDatabase(":memory:");
      db.prepare(`
        INSERT INTO knowledge_turns (turn_id, session_id, speaker, content, message_index, created_at)
        VALUES ('t2', 'sess1', 'assistant', 'SQLite FTS5 search pattern', 0, 1000)
      `).run();
      db.prepare("DELETE FROM knowledge_turns WHERE turn_id = 't2'").run();

      const result = db
        .prepare("SELECT rowid FROM knowledge_turns_fts WHERE knowledge_turns_fts MATCH 'sqlite'")
        .all();
      expect(result.length).toBe(0);
    });

    it("knowledge_turns schema has all required columns", () => {
      db = openDatabase(":memory:");
      const cols = db
        .prepare("SELECT name FROM pragma_table_info('knowledge_turns')")
        .all() as { name: string }[];
      const names = cols.map((c) => c.name);

      expect(names).toContain("turn_id");
      expect(names).toContain("session_id");
      expect(names).toContain("project");
      expect(names).toContain("user_id");
      expect(names).toContain("speaker");
      expect(names).toContain("content");
      expect(names).toContain("message_index");
      expect(names).toContain("created_at");
    });

    it("does not modify knowledge or knowledge_fts tables (additive only)", () => {
      db = openDatabase(":memory:");

      // knowledge table still has its original columns
      const knowledgeCols = db
        .prepare("SELECT name FROM pragma_table_info('knowledge')")
        .all() as { name: string }[];
      const kNames = knowledgeCols.map((c) => c.name);
      expect(kNames).toContain("summary");
      expect(kNames).toContain("details");
      expect(kNames).not.toContain("turn_id");

      // knowledge_fts still has its original columns
      const ftsSql = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_fts'")
        .get() as { sql: string } | undefined;
      expect(ftsSql).toBeDefined();
      expect(ftsSql!.sql).toContain("summary");
      expect(ftsSql!.sql).not.toContain("knowledge_turns");
    });
  });
});
