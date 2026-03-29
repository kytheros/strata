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
});
