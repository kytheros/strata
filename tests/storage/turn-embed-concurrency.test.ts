/**
 * PR4 — Task 2: Process-global concurrency cap on turn embedding.
 *
 * Validates that concurrent embedBatch calls across multiple
 * SqliteKnowledgeTurnStore instances (simulating multi-tenant load) are
 * capped at CONFIG.search.denseTurnLane.maxConcurrentEmbedBatches.
 *
 * A single large tenant's buildFullIndex fires many embedBatch calls
 * fire-and-forget. Without a cap, all tenants share the same GEMINI_API_KEY
 * — one tenant can exhaust the quota and degrade all others to FTS5-only.
 *
 * The process-global semaphore (module-level in sqlite-knowledge-turn-store.ts)
 * ensures peak concurrent embedBatch calls across ALL store instances stays
 * ≤ maxConcurrentEmbedBatches.
 */

import { describe, it, expect } from "vitest";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteKnowledgeTurnStore } from "../../src/storage/sqlite-knowledge-turn-store.js";
import { CONFIG } from "../../src/config.js";
import type { EmbeddingProvider } from "../../src/extensions/vector-search/embedding-provider.js";

/** Build a fake provider that records peak concurrency and blocks briefly. */
function makeConcurrencyTrackingProvider(holdMs = 20): {
  provider: EmbeddingProvider;
  peakConcurrent: () => number;
} {
  let current = 0;
  let peak = 0;

  const provider: EmbeddingProvider = {
    dimensions: 768,
    modelName: "test-model",
    supportsQuantization: false,
    embed: async (_t: string) => new Float32Array(768),
    embedBatch: async (texts: string[]) => {
      current++;
      if (current > peak) peak = current;
      // Hold for a fixed duration so we can observe peak concurrency
      await new Promise<void>(r => setTimeout(r, holdMs));
      current--;
      return texts.map(() => new Float32Array(768));
    },
  } as unknown as EmbeddingProvider;

  return {
    provider,
    peakConcurrent: () => peak,
  };
}

describe("SqliteKnowledgeTurnStore — process-global embed concurrency cap (PR4 Task 2)", () => {

  it("CONFIG.search.denseTurnLane.maxConcurrentEmbedBatches defaults to 5", () => {
    // Env var not set → default 5
    expect(CONFIG.search.denseTurnLane.maxConcurrentEmbedBatches).toBe(5);
  });

  it("respects STRATA_DENSE_TURN_MAX_CONCURRENCY env override", () => {
    const orig = process.env.STRATA_DENSE_TURN_MAX_CONCURRENCY;
    try {
      process.env.STRATA_DENSE_TURN_MAX_CONCURRENCY = "3";
      expect(CONFIG.search.denseTurnLane.maxConcurrentEmbedBatches).toBe(3);
    } finally {
      if (orig === undefined) delete process.env.STRATA_DENSE_TURN_MAX_CONCURRENCY;
      else process.env.STRATA_DENSE_TURN_MAX_CONCURRENCY = orig;
    }
  });

  it("peak concurrent embedBatch calls across N stores is ≤ maxConcurrentEmbedBatches", async () => {
    const limit = CONFIG.search.denseTurnLane.maxConcurrentEmbedBatches; // 5

    // Create 3 stores (simulating 3 tenants). Each embedBatch holds for 20ms.
    const dbs = [openDatabase(":memory:"), openDatabase(":memory:"), openDatabase(":memory:")];
    const { provider, peakConcurrent } = makeConcurrencyTrackingProvider(20);
    const stores = dbs.map(db => new SqliteKnowledgeTurnStore(db, provider));

    // Each store fires 4 bulkInserts × 1 turn each = 12 concurrent embedBatch
    // calls total across 3 tenants. Without the cap, peak would be 12. With the
    // cap at 5, peak must be ≤ 5. Each bulkInsert triggers one embedTurns call
    // (one embedBatch call) for the single turn.
    const makeTurn = (i: number) => ({
      sessionId: `s${i}`,
      project: "proj",
      userId: null,
      speaker: "user" as const,
      content: `turn content ${i} with enough text to not be filtered`,
      messageIndex: i,
    });

    // Fire all bulkInserts concurrently. bulkInsert completes the SQLite write
    // synchronously but fires embedTurns fire-and-forget. We collect the
    // insert promises AND wait for pending embeddings via flushPendingEmbeddings.
    const insertPromises = stores.flatMap((store, si) =>
      Array.from({ length: 4 }, (_, ti) =>
        store.bulkInsert([makeTurn(si * 4 + ti)])
      )
    );

    await Promise.all(insertPromises);

    // Flush all pending embeddings across all stores to ensure all embedBatch
    // calls have completed before we inspect peak concurrency.
    await Promise.all(stores.map(s => s.flushPendingEmbeddings()));

    // Clean up
    dbs.forEach(db => db.close());

    // Assert: peak concurrent embedBatch calls must not exceed the configured limit
    expect(peakConcurrent()).toBeLessThanOrEqual(limit);
    // Sanity: we actually ran some embedding (peak > 0)
    expect(peakConcurrent()).toBeGreaterThan(0);
  }, 15000);
});
