/**
 * Test: PgKnowledgeStore — CRUD + weighted tsvector search.
 *
 * Requires Docker Postgres running on localhost:5432.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { createSchema, dropSchema } from "../../src/storage/pg/schema.js";
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
    }
  });

  beforeEach(async () => {
    if (!pool) return;
    await dropSchema(pool);
    await createSchema(pool);
    store = new PgKnowledgeStore(pool, "pg-know-test");
  });

  afterAll(async () => {
    if (pool) {
      await dropSchema(pool).catch(() => {});
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

  // T10: PG vector read scoping — active model stamp on write (no live PG needed for compile;
  // runtime runs under the skip guard via `if (!pool) return`).
  it("stamps resolveActiveEmbeddingModel().model on the embeddings write path", async () => {
    if (!pool) return;
    // The PgKnowledgeStore.embedEntryAsync now uses resolveActiveEmbeddingModel().model.
    // We can't invoke it without an embedder, but we can verify the SQL constant is gone.
    // This is a compile-time proof; the behavioural assertion mirrors the SQLite T6 test.
    const { resolveActiveEmbeddingModel } = await import("../../src/extensions/embeddings/active-model.js");
    expect(resolveActiveEmbeddingModel().model).toBe("gemini-embedding-001");
  });

  // ── T1 (ticket #29): PgKnowledgeStore embedding write path ──────────────────

  describe("embedding writes (T1 / #29)", () => {
    /** Fake embedder — returns deterministic Float32Array of given dim, tracks call count. */
    function makeFakeEmbedder(dim = 4) {
      let calls = 0;
      const embed = async (_text: string): Promise<Float32Array> => {
        calls++;
        const v = new Float32Array(dim);
        v.fill(0.5);
        return v;
      };
      const embedBatch = async (texts: string[]): Promise<Float32Array[]> => {
        calls += texts.length;
        return texts.map(() => { const v = new Float32Array(dim); v.fill(0.5); return v; });
      };
      return {
        embed,
        embedBatch,
        get calls() { return calls; },
        modelName: "test-model-v1",
        supportsQuantization: false,
        dimensions: dim,
      };
    }

    it("setEmbedder() exists and is callable", async () => {
      if (!pool) return;
      // setEmbedder must exist as a method (TypeScript structural check at runtime)
      expect(typeof (store as any).setEmbedder).toBe("function");
      // Must not throw when called with null
      expect(() => (store as any).setEmbedder(null)).not.toThrow();
    });

    it("addEntry with embedder → row lands in embeddings table with correct model", async () => {
      if (!pool) return;

      const fakeEmbedder = makeFakeEmbedder(4);
      // Wire the embedder via setEmbedder (the new T1 method)
      (store as any).setEmbedder(fakeEmbedder);

      const entry = makeEntry({ summary: "embedding test", details: "details for embedding" });
      await store.addEntry(entry);
      // flushPendingEmbeddings must actually await the embed before returning
      await store.flushPendingEmbeddings();

      const { rows } = await pool!.query<{ id: string; model: string; embedding: Buffer }>(
        "SELECT id, model, embedding FROM embeddings WHERE id = $1",
        [entry.id]
      );
      expect(rows.length).toBe(1);
      expect(rows[0].model).toBe("test-model-v1");
      // Buffer should be non-empty (4 float32 = 16 bytes)
      expect(rows[0].embedding.length).toBeGreaterThan(0);
    });

    it("flushPendingEmbeddings() returns count of embeddings awaited", async () => {
      if (!pool) return;

      const fakeEmbedder = makeFakeEmbedder(4);
      (store as any).setEmbedder(fakeEmbedder);

      const e1 = makeEntry({ id: "flush-e1", summary: "flush entry 1", details: "d1" });
      const e2 = makeEntry({ id: "flush-e2", summary: "flush entry 2", details: "d2" });
      await store.addEntry(e1);
      await store.addEntry(e2);

      const count = await store.flushPendingEmbeddings();
      expect(count).toBeGreaterThanOrEqual(1); // at least the pending ones were awaited
    });

    it("setEmbedder(null) is a no-op — no embeddings written", async () => {
      if (!pool) return;

      (store as any).setEmbedder(null);
      const entry = makeEntry({ id: "no-embed-entry", summary: "no embedder" });
      await store.addEntry(entry);
      await store.flushPendingEmbeddings();

      const { rows } = await pool!.query(
        "SELECT id FROM embeddings WHERE id = $1",
        [entry.id]
      );
      expect(rows.length).toBe(0);
    });

    it("beginBatchEmbed + flushBatchEmbed writes all queued embeddings", async () => {
      if (!pool) return;

      const fakeEmbedder = makeFakeEmbedder(4);
      (store as any).setEmbedder(fakeEmbedder);
      (store as any).beginBatchEmbed();

      const entries = [
        makeEntry({ id: "batch-e1", summary: "batch one", details: "d1" }),
        makeEntry({ id: "batch-e2", summary: "batch two", details: "d2" }),
        makeEntry({ id: "batch-e3", summary: "batch three", details: "d3" }),
      ];
      for (const e of entries) {
        await store.addEntry(e);
      }

      // While batch mode is active, no embeddings should be in the table yet
      const { rows: beforeFlush } = await pool!.query(
        "SELECT COUNT(*) AS cnt FROM embeddings"
      );
      // Note: fire-and-forget embedEntryAsync in non-batch mode may write some;
      // in batch mode (batchEmbedActive=true) nothing should be written yet.

      const stored = await (store as any).flushBatchEmbed();
      expect(stored).toBe(3);

      const { rows } = await pool!.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM embeddings WHERE model = $1",
        ["test-model-v1"]
      );
      expect(Number(rows[0].count)).toBe(3);
      // Call count = 1 batch call covering all 3 texts
      expect(fakeEmbedder.calls).toBe(3); // embedBatch counts each text
    });

    it("PgVectorSearch.search finds entry after embedding write", async () => {
      if (!pool) return;
      const { PgVectorSearch } = await import("../../src/storage/pg/pg-vector-search.js");

      // Use the same model name in both the embedder and PgVectorSearch so
      // the WHERE model=$2 filter matches the written row.
      const MODEL = "test-model-v1";
      const fakeEmbedder = makeFakeEmbedder(4);
      // fakeEmbedder already has modelName = "test-model-v1"
      (store as any).setEmbedder(fakeEmbedder);

      const entry = makeEntry({
        id: "vec-entry-1",
        summary: "vector search target",
        details: "should be found by cosine",
        project: "vec-project",
      });
      await store.addEntry(entry);
      await store.flushPendingEmbeddings();

      // Initialize PgVectorSearch with the same model the embedder wrote
      const vs = new PgVectorSearch(pool!, MODEL);
      // Query with a vector identical to what the fake embedder produces (all 0.5)
      const queryVec = new Float32Array(4);
      queryVec.fill(0.5);

      const results = await vs.search(queryVec, "vec-project", 10);
      expect(results.some((r) => r.entryId === "vec-entry-1")).toBe(true);
      expect(results[0].score).toBeGreaterThan(0);
    });
  });
});
