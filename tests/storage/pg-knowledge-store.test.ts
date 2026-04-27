/**
 * Test: PgKnowledgeStore — CRUD + weighted tsvector search.
 *
 * Requires Docker Postgres running on localhost:5432.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { createSchema } from "../../src/storage/pg/schema.js";
import { PgKnowledgeStore } from "../../src/storage/pg/pg-knowledge-store.js";
import type { KnowledgeEntry } from "../../src/knowledge/knowledge-store.js";

const PG_URL = process.env.PG_URL || "postgresql://postgres:test@localhost:5432/postgres";

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: `entry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "decision",
    project: "test-project",
    sessionId: "session-1",
    timestamp: Date.now(),
    summary: "Test summary",
    details: "Test details",
    tags: ["test"],
    relatedFiles: [],
    ...overrides,
  };
}

describe("PgKnowledgeStore", () => {
  let pool: pg.Pool | undefined;
  let store: PgKnowledgeStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL, max: 5 });
    try {
      await pool.query("SELECT 1");
    } catch {
      console.log("Postgres not available -- skipping PgKnowledgeStore tests");
      await pool.end();
      pool = undefined;
      return;
    }

    await createSchema(pool);
    store = new PgKnowledgeStore(pool, "pg-know-test");
  });

  beforeEach(async () => {
    if (!pool) return;
    await pool.query("DELETE FROM knowledge_history WHERE entry_id IN (SELECT id FROM knowledge WHERE user_scope = 'pg-know-test')");
    await pool.query("DELETE FROM knowledge_entities WHERE entry_id IN (SELECT id FROM knowledge WHERE user_scope = 'pg-know-test')");
    await pool.query("DELETE FROM knowledge WHERE user_scope = 'pg-know-test'");
  });

  afterAll(async () => {
    if (pool) {
      await pool.query("DELETE FROM knowledge_history WHERE entry_id IN (SELECT id FROM knowledge WHERE user_scope IN ('pg-know-test','know-user-a','know-user-b'))").catch(() => {});
      await pool.query("DELETE FROM knowledge_entities WHERE entry_id IN (SELECT id FROM knowledge WHERE user_scope IN ('pg-know-test','know-user-a','know-user-b'))").catch(() => {});
      await pool.query("DELETE FROM knowledge WHERE user_scope IN ('pg-know-test','know-user-a','know-user-b')").catch(() => {});
      await pool.end();
    }
  });

  it("should add and retrieve an entry", async () => {
    if (!pool) return;
    const entry = makeEntry({ summary: "Use TypeScript strict mode" });
    await store.addEntry(entry);

    const retrieved = await store.getEntry(entry.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.summary).toBe("Use TypeScript strict mode");
    expect(retrieved!.type).toBe("decision");
  });

  it("should deduplicate by project+type+summary+user", async () => {
    if (!pool) return;
    const entry1 = makeEntry({ summary: "dedup test" });
    const entry2 = makeEntry({ summary: "dedup test" });

    await store.addEntry(entry1);
    await store.addEntry(entry2);

    const count = await store.getEntryCount();
    expect(count).toBe(1);
  });

  it("should upsert (insert or replace)", async () => {
    if (!pool) return;
    const entry = makeEntry({ summary: "original" });
    await store.upsertEntry(entry);

    const updated = { ...entry, summary: "updated" };
    await store.upsertEntry(updated);

    const retrieved = await store.getEntry(entry.id);
    expect(retrieved!.summary).toBe("updated");
  });

  it("should search using weighted tsvector (summary=A gets priority)", async () => {
    if (!pool) return;
    // Entry with term in summary (weight A)
    await store.addEntry(makeEntry({
      id: "k-summary",
      summary: "PostgreSQL database optimization techniques",
      details: "Various methods for improving DB performance",
    }));
    // Entry with term in details only (weight B)
    await store.addEntry(makeEntry({
      id: "k-details",
      summary: "General performance tuning guide",
      details: "PostgreSQL can be tuned using various parameters",
    }));

    const results = await store.search("PostgreSQL");
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Summary match should rank higher
    expect(results[0].id).toBe("k-summary");
  });

  it("should filter search by project", async () => {
    if (!pool) return;
    await store.addEntry(makeEntry({ id: "k-proj-a", project: "project-a", summary: "Redis caching strategy" }));
    await store.addEntry(makeEntry({ id: "k-proj-b", project: "project-b", summary: "Redis caching layer" }));

    const results = await store.search("Redis caching", "project-a");
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("k-proj-a");
  });

  it("should update entry and record history", async () => {
    if (!pool) return;
    const entry = makeEntry({ summary: "original" });
    await store.addEntry(entry);

    await store.updateEntry(entry.id, { summary: "updated" });

    const retrieved = await store.getEntry(entry.id);
    expect(retrieved!.summary).toBe("updated");

    const history = await store.getHistory(entry.id);
    expect(history.length).toBeGreaterThanOrEqual(2);
  });

  it("should delete entry", async () => {
    if (!pool) return;
    const entry = makeEntry();
    await store.addEntry(entry);

    const result = await store.deleteEntry(entry.id);
    expect(result).toBe(true);
    expect(await store.getEntry(entry.id)).toBeUndefined();
  });

  it("should get entries by type", async () => {
    if (!pool) return;
    await store.addEntry(makeEntry({ type: "decision", summary: "decision 1" }));
    await store.addEntry(makeEntry({ type: "solution", summary: "solution 1" }));

    const decisions = await store.getByType("decision");
    expect(decisions.every((e) => e.type === "decision")).toBe(true);
  });

  it("should paginate with getEntries", async () => {
    if (!pool) return;
    for (let i = 0; i < 5; i++) {
      await store.addEntry(makeEntry({ summary: `entry-${i}` }));
    }

    const page1 = await store.getEntries({ limit: 2, offset: 0 });
    expect(page1.entries.length).toBe(2);
    expect(page1.total).toBe(5);

    const page2 = await store.getEntries({ limit: 2, offset: 2 });
    expect(page2.entries.length).toBe(2);
  });

  it("should isolate entries by user scope", async () => {
    if (!pool) return;
    const storeA = new PgKnowledgeStore(pool!, "know-user-a");
    const storeB = new PgKnowledgeStore(pool!, "know-user-b");

    await storeA.addEntry(makeEntry({ user: "know-user-a", summary: "user A data" }));
    await storeB.addEntry(makeEntry({ user: "know-user-b", summary: "user B data" }));

    const countA = await storeA.getEntryCount();
    const countB = await storeB.getEntryCount();
    expect(countA).toBe(1);
    expect(countB).toBe(1);

    // Cross-user visibility: user A can't see user B's entries
    const entriesA = await storeA.getAllEntries();
    expect(entriesA.every((e) => e.user === "know-user-a")).toBe(true);
  });

  it("should get type distribution", async () => {
    if (!pool) return;
    await store.addEntry(makeEntry({ type: "decision", summary: "d1" }));
    await store.addEntry(makeEntry({ type: "decision", summary: "d2" }));
    await store.addEntry(makeEntry({ type: "solution", summary: "s1" }));

    const dist = await store.getTypeDistribution();
    expect(dist["decision"]).toBe(2);
    expect(dist["solution"]).toBe(1);
  });
});
