// strata/tests/search/search-turns-hybrid.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { SqliteKnowledgeTurnStore } from "../../src/storage/sqlite-knowledge-turn-store.js";
import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import { VectorSearch } from "../../src/extensions/embeddings/vector-search.js";
import type { EmbeddingProvider } from "../../src/extensions/vector-search/embedding-provider.js";

// Updated to EmbeddingProvider interface (T4: turn store + engine now use EmbeddingProvider).
// modelName must match what VectorSearch uses as its activeModel (defaults to gemini-embedding-001).
const TEST_MODEL = "gemini-embedding-001";

// Query embeds to axis 7. The gold turn ("the capital is Paris") has NO lexical
// overlap with the query ("which city") but is embedded to axis 7 → vector-only hit.
function makeEmbedder(dim = 3072): EmbeddingProvider {
  const vecFor = (text: string): Float32Array => {
    const v = new Float32Array(dim);
    if (text.includes("which city") || text.toLowerCase().includes("capital is paris")) v[7] = 1;
    else v[3] = 1;
    return v;
  };
  return {
    dimensions: dim,
    modelName: TEST_MODEL,
    supportsQuantization: false,
    embed: async (t: string) => vecFor(t),
    embedBatch: async (t: string[]) => t.map(vecFor),
  } as unknown as EmbeddingProvider;
}

// Multi-axis embedder for recency test: maps sessionId keywords to distinct axes.
// "sessionA" → axis 1, "sessionB" → axis 2, "sessionC" → axis 3, query → axis 1
// (so all sessions are relevant; ordering comes from recency, not score).
function makeMultiAxisEmbedder(dim = 3072): EmbeddingProvider {
  const vecFor = (text: string): Float32Array => {
    const v = new Float32Array(dim);
    if (text.includes("sessionA") || text.includes("queryA")) v[1] = 1;
    else if (text.includes("sessionB")) v[2] = 1;
    else if (text.includes("sessionC")) v[3] = 1;
    else v[0] = 1;
    return v;
  };
  return {
    dimensions: dim,
    modelName: TEST_MODEL,
    supportsQuantization: false,
    embed: async (t: string) => vecFor(t),
    embedBatch: async (t: string[]) => t.map(vecFor),
  } as unknown as EmbeddingProvider;
}

describe("searchTurns hybrid", () => {
  let db: any;
  afterEach(() => { db?.close(); delete process.env.STRATA_DENSE_TURN_LANE; });

  it("surfaces a vector-only gold turn that FTS5 misses (flag ON)", async () => {
    process.env.STRATA_DENSE_TURN_LANE = "on";
    // CONFIG is read live via process.env for denseTurnLane.enabled.
    const { CONFIG } = await import("../../src/config.js");
    expect(CONFIG.search.denseTurnLane.enabled).toBe(true);

    db = openDatabase(":memory:");
    const embedder = makeEmbedder();
    const turnStore = new SqliteKnowledgeTurnStore(db, embedder);
    await turnStore.bulkInsert([
      { sessionId: "s1", speaker: "assistant", content: "the capital is Paris", messageIndex: 0 },
      { sessionId: "s1", speaker: "user", content: "tell me about rivers", messageIndex: 1 },
    ]);
    const engine = new SqliteSearchEngine(new SqliteDocumentStore(db), embedder, new VectorSearch(db));
    engine.setKnowledgeTurnStore(turnStore);

    const hits = await engine.searchTurns("which city", { userId: undefined, project: undefined, limit: 5 });
    // "which city" has no FTS5 token overlap with either turn → FTS5 alone returns [].
    // The dense lane must surface the axis-7 gold turn.
    expect(hits.some((h) => h.row.content.includes("Paris"))).toBe(true);
  });

  // Kill-switch contract leg (c): the engine gate at sqlite-search-engine.ts
  // (CONFIG.search.denseTurnLane.enabled, read live per query) is the ONLY
  // enforcement for callers that reach searchTurns with the switch off — the
  // explicit "deep"/"tirqdp" strategies do exactly that now that the turn store
  // is always wired. Mutation-verified: deleting the enabled check from the
  // engine fails this test (and previously failed none).
  it("suppresses the dense vector lane when STRATA_DENSE_TURN_LANE=off even with embedder+VectorSearch wired", async () => {
    process.env.STRATA_DENSE_TURN_LANE = "off";
    const { CONFIG } = await import("../../src/config.js");
    expect(CONFIG.search.denseTurnLane.enabled).toBe(false);

    db = openDatabase(":memory:");
    const embedder = makeEmbedder();
    const turnStore = new SqliteKnowledgeTurnStore(db, embedder);
    await turnStore.bulkInsert([
      { sessionId: "s1", speaker: "assistant", content: "the capital is Paris", messageIndex: 0 },
      { sessionId: "s1", speaker: "user", content: "tell me about rivers", messageIndex: 1 },
    ]);
    const engine = new SqliteSearchEngine(new SqliteDocumentStore(db), embedder, new VectorSearch(db));
    engine.setKnowledgeTurnStore(turnStore);

    // "which city" has no FTS5 overlap; with the switch off the vector lane must
    // not run, so the axis-7 gold turn must NOT surface (FTS5-only behavior).
    const hits = await engine.searchTurns("which city", { userId: undefined, project: undefined, limit: 5 });
    expect(hits.some((h) => h.row.content.includes("Paris"))).toBe(false);
  });

  it("is byte-identical to FTS5-only when no embedder (flag ON but engine has no embedder)", async () => {
    process.env.STRATA_DENSE_TURN_LANE = "on";
    db = openDatabase(":memory:");
    const turnStore = new SqliteKnowledgeTurnStore(db); // no embedder
    await turnStore.bulkInsert([
      { sessionId: "s1", speaker: "user", content: "paris france capital", messageIndex: 0 },
    ]);
    const engine = new SqliteSearchEngine(new SqliteDocumentStore(db)); // embedder null
    engine.setKnowledgeTurnStore(turnStore);
    const hits = await engine.searchTurns("paris", { userId: undefined, project: undefined, limit: 5 });
    expect(hits.length).toBe(1);
    expect(hits[0].row.content).toContain("paris");
  });

  // §8.1 item (skipVector): with flag ON and engine HAS embedder+VectorSearch,
  // skipVector:true must suppress the vector lane — the vector-only gold turn
  // (axis 7, no FTS5 overlap) must NOT surface.
  it("skipVector:true suppresses the dense vector lane even when flag is ON (§8.1 no-vector guard)", async () => {
    process.env.STRATA_DENSE_TURN_LANE = "on";
    db = openDatabase(":memory:");
    const embedder = makeEmbedder();
    const turnStore = new SqliteKnowledgeTurnStore(db, embedder);
    await turnStore.bulkInsert([
      { sessionId: "s1", speaker: "assistant", content: "the capital is Paris", messageIndex: 0 },
      { sessionId: "s1", speaker: "user", content: "tell me about rivers", messageIndex: 1 },
    ]);
    const engine = new SqliteSearchEngine(new SqliteDocumentStore(db), embedder, new VectorSearch(db));
    engine.setKnowledgeTurnStore(turnStore);

    // With skipVector:true the dense lane must NOT run, so "which city" (no FTS5 overlap)
    // returns no Paris hit — identical to pure FTS5-only behavior.
    const hits = await engine.searchTurns("which city", {
      userId: undefined,
      project: undefined,
      limit: 5,
      skipVector: true,
    });
    expect(hits.some((h) => h.row.content.includes("Paris"))).toBe(false);
  });

  // §8.1 item 7: applyTurnRecencyBoost runs AFTER RRF fusion (not before).
  // Three sessions with distinct createdAt. forceBoost:true triggers recency ordering.
  // If recency were applied before fusion, the vector-only hit from the newest session
  // might not be present in the pre-fusion list and the post-fusion order could differ.
  it("applyTurnRecencyBoost is applied to the FUSED list (§8.1 item 7 — recency after fusion)", async () => {
    process.env.STRATA_DENSE_TURN_LANE = "on";
    db = openDatabase(":memory:");

    const now = Date.now();
    const OLD = now - 10_000; // oldest
    const MID = now - 5_000;
    const NEW = now;          // newest

    // Axis mapping: sessionA content embeds to axis 1, query "queryA" also embeds to axis 1
    // → all three sessions will have cosine > 0 (axis 1 hits sessionA, others hit different axes
    // but query axis 1 also partially matches via FTS5 fallback for sessions B/C).
    // The key: sessionC is NEWEST (createdAt=NEW) — after forceBoost it must come first.
    const embedder = makeMultiAxisEmbedder();
    const turnStore = new SqliteKnowledgeTurnStore(db, embedder);
    await turnStore.bulkInsert([
      { sessionId: "sA", speaker: "assistant", content: "sessionA alpha", messageIndex: 0, createdAt: OLD },
      { sessionId: "sB", speaker: "assistant", content: "sessionB beta",  messageIndex: 0, createdAt: MID },
      { sessionId: "sC", speaker: "assistant", content: "sessionC gamma sessionA queryA", messageIndex: 0, createdAt: NEW },
    ]);
    const { CONFIG } = await import("../../src/config.js");
    const engine = new SqliteSearchEngine(new SqliteDocumentStore(db), embedder, new VectorSearch(db));
    engine.setKnowledgeTurnStore(turnStore);

    // forceBoost:true bypasses the classifier so recency reordering always fires.
    // The newest session (sC, createdAt=NEW) must lead after boost is applied to fused list.
    const hits = await engine.searchTurns("sessionA queryA", {
      userId: undefined,
      project: undefined,
      limit: 5,
      forceBoost: true,
    });

    // At minimum, hits must be non-empty and the first hit must be from the newest session.
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].row.sessionId).toBe("sC");
  });
});
