/**
 * PgVectorSearch integration tests — requires Postgres at PG_URL.
 * Skips gracefully when unavailable.
 *
 * Spec: 2026-06-03-dense-turn-lane-production-design.md (PR2 / T4)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { createSchema, dropSchema } from "../../src/storage/pg/schema.js";
import { PgVectorSearch } from "../../src/storage/pg/pg-vector-search.js";
import { PgKnowledgeTurnStore } from "../../src/storage/pg/pg-knowledge-turn-store.js";
import type { EmbeddingProvider } from "../../src/extensions/vector-search/embedding-provider.js";
import type { IVectorSearch } from "../../src/extensions/embeddings/vector-search.js";

const PG_URL =
  process.env.PG_URL || "postgresql://postgres:test@localhost:5432/postgres";

function makeFakeProvider(dim = 3072): EmbeddingProvider {
  const v = () => { const a = new Float32Array(dim); a[0] = 1; return a; };
  return {
    dimensions: dim,
    modelName: "fake-model",
    supportsQuantization: false,
    embed: async () => v(),
    embedBatch: async (ts: string[]) => ts.map(v),
  } as unknown as EmbeddingProvider;
}

describe("PgVectorSearch", () => {
  let pool: pg.Pool | undefined;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL, max: 3 });
    try {
      await pool.query("SELECT 1");
      await dropSchema(pool);
      await createSchema(pool);
    } catch {
      console.log("[pg-vs-test] Postgres not available — skipping PgVectorSearch tests");
      await pool.end();
      pool = undefined;
    }
  });

  afterAll(async () => {
    if (pool) {
      await dropSchema(pool).catch(() => {});
      await pool.end();
    }
  });

  it("PgVectorSearch satisfies IVectorSearch (compile-time duck-type check)", () => {
    // Structural type check: PgVectorSearch must be assignable to IVectorSearch.
    // This test fails at compile time if searchTurnEmbeddings is missing.
    if (!pool) return;
    const vs: IVectorSearch = new PgVectorSearch(pool, "fake-model");
    expect(vs).toBeDefined();
  });

  it("searchTurnEmbeddings returns [] on empty table", async () => {
    if (!pool) return;
    const vs = new PgVectorSearch(pool, "fake-model");
    const queryVec = new Float32Array(3072);
    queryVec[0] = 1;
    const results = await vs.searchTurnEmbeddings(queryVec, 10);
    expect(results).toEqual([]);
  });

  it("searchTurnEmbeddings returns matching turns after embedTurns writes", async () => {
    if (!pool) return;
    const provider = makeFakeProvider();
    const turnStore = new PgKnowledgeTurnStore(pool, provider);
    await turnStore.bulkInsert([
      { sessionId: "s1", userId: "u1", speaker: "user", content: "alpha query", messageIndex: 0 },
      { sessionId: "s1", userId: "u1", speaker: "assistant", content: "beta answer", messageIndex: 1 },
    ]);

    const vs = new PgVectorSearch(pool, "fake-model");
    const queryVec = new Float32Array(3072);
    queryVec[0] = 1;
    const results = await vs.searchTurnEmbeddings(queryVec, 5, { userId: "u1" });
    expect(results.length).toBe(2);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("searchTurnEmbeddings respects userId scope", async () => {
    if (!pool) return;
    const provider = makeFakeProvider();
    const turnStore = new PgKnowledgeTurnStore(pool, provider);
    await turnStore.bulkInsert([
      { sessionId: "s2", userId: "user-A", speaker: "user", content: "message for A", messageIndex: 0 },
      { sessionId: "s3", userId: "user-B", speaker: "user", content: "message for B", messageIndex: 0 },
    ]);

    const vs = new PgVectorSearch(pool, "fake-model");
    const queryVec = new Float32Array(3072);
    queryVec[0] = 1;
    const resultsA = await vs.searchTurnEmbeddings(queryVec, 10, { userId: "user-A" });
    const resultsB = await vs.searchTurnEmbeddings(queryVec, 10, { userId: "user-B" });
    // Each user scope returns only their own turns
    expect(resultsA.length).toBeGreaterThanOrEqual(1);
    expect(resultsB.length).toBeGreaterThanOrEqual(1);
    // No result from B in A's scope (turn_ids are distinct)
    const aIds = new Set(resultsA.map(r => r.entryId));
    const bIds = new Set(resultsB.map(r => r.entryId));
    for (const id of bIds) expect(aIds.has(id)).toBe(false);
  });

  it("bulkInsert writes embedding rows when an embedder is injected", async () => {
    if (!pool) return;

    function fakeProvider(): EmbeddingProvider {
      const v = () => { const a = new Float32Array(3072); a[0] = 1; return a; };
      return {
        dimensions: 3072,
        modelName: "test-model",
        supportsQuantization: false,
        embed: async () => v(),
        embedBatch: async (ts: string[]) => ts.map(v),
      } as unknown as EmbeddingProvider;
    }

    const storeWithEmbedder = new PgKnowledgeTurnStore(pool, fakeProvider());
    await storeWithEmbedder.bulkInsert([
      { sessionId: "s-embed-test", speaker: "user", content: "hello embedding", messageIndex: 0 },
    ]);
    const { rows } = await pool.query("SELECT COUNT(*)::integer AS cnt FROM knowledge_turn_embeddings");
    expect(rows[0].cnt).toBeGreaterThanOrEqual(1);
  });
});
