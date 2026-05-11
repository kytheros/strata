/**
 * TDD tests for knowledge_entities junction write-path fix.
 *
 * Bug: store_memory never extracted entities from stored memory text and
 * never called linkToKnowledge(). The knowledge_entities junction table
 * remained empty even when entities/entity_relations were populated.
 *
 * Fix: handleStoreMemory must accept an optional IEntityStore and call
 * extractEntities() + linkToKnowledge() on the written entry.
 *
 * Ticket: knowledge_entities junction write-path fix
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import { SqliteEntityStore } from "../../src/storage/sqlite-entity-store.js";
import { handleStoreMemory } from "../../src/tools/store-memory.js";

// Mock the gemini provider to return null (no LLM in tests)
vi.mock("../../src/extensions/llm-extraction/gemini-provider.js", () => ({
  getCachedGeminiProvider: vi.fn().mockResolvedValue(null),
}));

// ── Unit test: write-path fix ────────────────────────────────────────────────

describe("store_memory entity junction write-path", () => {
  let db: Database.Database;
  let knowledgeStore: SqliteKnowledgeStore;
  let entityStore: SqliteEntityStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    knowledgeStore = new SqliteKnowledgeStore(db);
    entityStore = new SqliteEntityStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("RED: writes knowledge_entities rows when memory mentions known entities", async () => {
    // Ingest a memory that mentions two known entities (Postgres and SQLite)
    const result = await handleStoreMemory(
      knowledgeStore,
      {
        memory: "Decided to use Postgres for production and SQLite for tests",
        type: "decision",
        project: "my-project",
      },
      db,
      entityStore // NEW 4th argument: entity store
    );

    expect(result).toContain("Stored decision");

    // The junction table must have rows
    const junctionRows = db
      .prepare("SELECT COUNT(*) as count FROM knowledge_entities")
      .get() as { count: number };
    expect(junctionRows.count).toBeGreaterThan(0);

    // Both entities should be in the entities table
    const entityRows = db
      .prepare("SELECT canonical_name FROM entities ORDER BY canonical_name")
      .all() as { canonical_name: string }[];
    const canonicalNames = entityRows.map((r) => r.canonical_name);
    expect(canonicalNames).toContain("postgresql");
    expect(canonicalNames).toContain("sqlite");
  });

  it("writes one knowledge_entities row per entity found", async () => {
    await handleStoreMemory(
      knowledgeStore,
      {
        memory: "Switched from React to Vue for the frontend, using Vite as the bundler",
        type: "decision",
        project: "my-project",
      },
      db,
      entityStore
    );

    // react, vue, vite should all be detected
    const entityRows = db
      .prepare("SELECT canonical_name FROM entities ORDER BY canonical_name")
      .all() as { canonical_name: string }[];
    const names = entityRows.map((r) => r.canonical_name);
    expect(names).toContain("react");
    expect(names).toContain("vue");
    expect(names).toContain("vite");

    // Junction rows: each entry_id→entity_id pair
    const junctionRows = db
      .prepare("SELECT * FROM knowledge_entities")
      .all() as Array<{ entry_id: string; entity_id: string }>;
    expect(junctionRows.length).toBeGreaterThanOrEqual(3);

    // All junction rows reference the same knowledge entry
    const entryIds = new Set(junctionRows.map((r) => r.entry_id));
    expect(entryIds.size).toBe(1);
  });

  it("works without entity store (backward compat — no entity store = no junction writes)", async () => {
    // When entityStore is omitted, should NOT throw; junction table stays empty
    const result = await handleStoreMemory(
      knowledgeStore,
      {
        memory: "Postgres is the primary database for this project",
        type: "decision",
      },
      db
      // no entityStore argument
    );

    expect(result).toContain("Stored decision");

    const junctionRows = db
      .prepare("SELECT COUNT(*) as count FROM knowledge_entities")
      .get() as { count: number };
    expect(junctionRows.count).toBe(0); // no entity store = no junction writes
  });

  it("does not write junction rows when memory mentions no known entities", async () => {
    await handleStoreMemory(
      knowledgeStore,
      {
        memory: "Remember to drink water and take breaks every hour",
        type: "learning",
      },
      db,
      entityStore
    );

    const junctionRows = db
      .prepare("SELECT COUNT(*) as count FROM knowledge_entities")
      .get() as { count: number };
    expect(junctionRows.count).toBe(0);
  });

  it("junction rows are idempotent — calling store_memory twice with same entity does not double-write", async () => {
    await handleStoreMemory(
      knowledgeStore,
      { memory: "Using Postgres for storage", type: "decision" },
      db,
      entityStore
    );
    await handleStoreMemory(
      knowledgeStore,
      { memory: "Also using Postgres for caching", type: "decision" },
      db,
      entityStore
    );

    // Two separate knowledge entries, but same entity 'postgresql'
    const entityRows = db
      .prepare("SELECT id, canonical_name FROM entities WHERE canonical_name = 'postgresql'")
      .all() as { id: string; canonical_name: string }[];
    expect(entityRows.length).toBe(1); // entity deduped by canonical_name

    const junctionRows = db
      .prepare("SELECT * FROM knowledge_entities WHERE entity_id = ?")
      .all(entityRows[0].id) as Array<{ entry_id: string; entity_id: string }>;
    // Two knowledge entries → two junction rows (both link to same entity)
    expect(junctionRows.length).toBe(2);
  });
});
