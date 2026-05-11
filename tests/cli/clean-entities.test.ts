/**
 * Tests for the clean-entities CLI command.
 * Removes tag-fragment pollution entities from the entity store.
 *
 * Ticket: entity extractor pollution fix (strata-mcp@2.2.2)
 *
 * RED step: these tests fail until cleanEntities() is implemented.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { SqliteEntityStore } from "../../src/storage/sqlite-entity-store.js";
import { cleanEntities, type CleanEntitiesResult } from "../../src/cli/clean-entities.js";

// ── Minimal in-memory schema for testing ─────────────────────────────────────

function buildTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'library',
      canonical_name TEXT NOT NULL,
      aliases TEXT NOT NULL DEFAULT '[]',
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      mention_count INTEGER NOT NULL DEFAULT 1,
      project TEXT,
      user TEXT
    );

    CREATE TABLE knowledge (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      project TEXT,
      session_id TEXT,
      timestamp INTEGER NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      details TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      related_files TEXT NOT NULL DEFAULT '[]',
      extracted_at INTEGER
    );

    CREATE TABLE knowledge_entities (
      entry_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      PRIMARY KEY (entry_id, entity_id)
    );

    CREATE TABLE entity_relations (
      id TEXT PRIMARY KEY,
      source_entity_id TEXT NOT NULL,
      target_entity_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      context TEXT,
      session_id TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

function insertEntity(db: Database.Database, id: string, name: string, canonicalName: string): void {
  db.prepare(`
    INSERT INTO entities (id, name, type, canonical_name, aliases, first_seen, last_seen)
    VALUES (?, ?, 'library', ?, '[]', ?, ?)
  `).run(id, name, canonicalName, Date.now(), Date.now());
}

function insertKnowledge(db: Database.Database, id: string): void {
  db.prepare(`
    INSERT INTO knowledge (id, type, timestamp, summary, details, tags, related_files)
    VALUES (?, 'decision', ?, 'test summary', 'test details', '[]', '[]')
  `).run(id, Date.now());
}

function linkKnowledgeEntity(db: Database.Database, entryId: string, entityId: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO knowledge_entities (entry_id, entity_id) VALUES (?, ?)
  `).run(entryId, entityId);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("cleanEntities", () => {
  let db: Database.Database;
  let entityStore: SqliteEntityStore;

  beforeEach(() => {
    db = buildTestDb();
    entityStore = new SqliteEntityStore(db);
  });

  it("should remove known tag-fragment entities", async () => {
    // Insert pollution entities
    insertEntity(db, "e1", "tool-use-id", "tool-use-id");
    insertEntity(db, "e2", "task-notification", "task-notification");
    insertEntity(db, "e3", "task-id", "task-id");
    insertEntity(db, "e4", "command-message", "command-message");
    insertEntity(db, "e5", "command-args", "command-args");
    insertEntity(db, "e6", "command-name", "command-name");
    insertEntity(db, "e7", "ask-id", "ask-id");
    insertEntity(db, "e8", "ommand-message", "ommand-message");

    const result = await cleanEntities({ db, dryRun: false });

    expect(result.entitiesRemoved).toBeGreaterThanOrEqual(8);
    expect(result.junctionRowsRemoved).toBe(0); // No junction rows in this test

    // Verify they are gone from DB
    const remaining = db.prepare("SELECT id FROM entities").all() as { id: string }[];
    expect(remaining).toHaveLength(0);
  });

  it("should also remove junction rows that reference removed entities", async () => {
    insertEntity(db, "e1", "tool-use-id", "tool-use-id");
    insertEntity(db, "e2", "react", "react"); // real entity
    insertKnowledge(db, "k1");
    linkKnowledgeEntity(db, "k1", "e1"); // pollution junction
    linkKnowledgeEntity(db, "k1", "e2"); // real junction

    const result = await cleanEntities({ db, dryRun: false });

    expect(result.entitiesRemoved).toBe(1);
    expect(result.junctionRowsRemoved).toBe(1);

    // real entity still present
    const remaining = db.prepare("SELECT id FROM entities").all() as { id: string }[];
    expect(remaining).toHaveLength(1);
    expect((remaining[0] as { id: string }).id).toBe("e2");

    // real junction still present
    const junctionRows = db.prepare("SELECT * FROM knowledge_entities").all();
    expect(junctionRows).toHaveLength(1);
  });

  it("should be idempotent — running twice gives same result", async () => {
    insertEntity(db, "e1", "tool-use-id", "tool-use-id");
    insertKnowledge(db, "k1");
    linkKnowledgeEntity(db, "k1", "e1");

    const r1 = await cleanEntities({ db, dryRun: false });
    const r2 = await cleanEntities({ db, dryRun: false });

    expect(r1.entitiesRemoved).toBe(1);
    expect(r2.entitiesRemoved).toBe(0); // already gone
  });

  it("should dry-run: report counts without deleting", async () => {
    insertEntity(db, "e1", "command-message", "command-message");
    insertEntity(db, "e2", "task-id", "task-id");
    insertKnowledge(db, "k1");
    linkKnowledgeEntity(db, "k1", "e1");

    const result = await cleanEntities({ db, dryRun: true });

    expect(result.entitiesRemoved).toBe(2);
    expect(result.junctionRowsRemoved).toBe(1);

    // Nothing actually deleted
    const entities = db.prepare("SELECT id FROM entities").all();
    expect(entities).toHaveLength(2);
    const junctions = db.prepare("SELECT * FROM knowledge_entities").all();
    expect(junctions).toHaveLength(1);
  });

  it("should not remove legitimate tech entities with hyphens", async () => {
    insertEntity(db, "e1", "better-sqlite3", "better-sqlite3");
    insertEntity(db, "e2", "fast-json-stringify", "fast-json-stringify");
    insertEntity(db, "e3", "strata-mcp", "strata-mcp");
    insertEntity(db, "e4", "tool-use-id", "tool-use-id"); // pollution

    const result = await cleanEntities({ db, dryRun: false });

    expect(result.entitiesRemoved).toBe(1); // Only tool-use-id removed

    const remaining = db.prepare("SELECT canonical_name FROM entities").all() as { canonical_name: string }[];
    const names = remaining.map((r) => r.canonical_name);
    expect(names).toContain("better-sqlite3");
    expect(names).toContain("fast-json-stringify");
    expect(names).toContain("strata-mcp");
    expect(names).not.toContain("tool-use-id");
  });

  it("should handle empty entity table gracefully", async () => {
    const result = await cleanEntities({ db, dryRun: false });
    expect(result.entitiesRemoved).toBe(0);
    expect(result.junctionRowsRemoved).toBe(0);
  });

  it("should log progress when log function is provided", async () => {
    insertEntity(db, "e1", "tool-use-id", "tool-use-id");

    const lines: string[] = [];
    await cleanEntities({ db, dryRun: false, log: (line) => lines.push(line) });

    expect(lines.some((l) => l.includes("tool-use-id"))).toBe(true);
    expect(lines.some((l) => l.includes("1"))).toBe(true);
  });

  it("should remove ommand-* variants (partial tag strip artifacts)", async () => {
    insertEntity(db, "e1", "ommand-message", "ommand-message");
    insertEntity(db, "e2", "ommand-args", "ommand-args");
    insertEntity(db, "e3", "ommand-name", "ommand-name");

    const result = await cleanEntities({ db, dryRun: false });
    expect(result.entitiesRemoved).toBe(3);
  });
});
