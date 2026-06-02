// strata/tests/search/search-turns-hybrid.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { SqliteKnowledgeTurnStore } from "../../src/storage/sqlite-knowledge-turn-store.js";
import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import { VectorSearch } from "../../src/extensions/embeddings/vector-search.js";
import type { GeminiEmbedder } from "../../src/extensions/embeddings/gemini-embedder.js";

// Query embeds to axis 7. The gold turn ("the capital is Paris") has NO lexical
// overlap with the query ("which city") but is embedded to axis 7 → vector-only hit.
function makeEmbedder(dim = 3072): GeminiEmbedder {
  const vecFor = (text: string): Float32Array => {
    const v = new Float32Array(dim);
    if (text.includes("which city") || text.toLowerCase().includes("capital is paris")) v[7] = 1;
    else v[3] = 1;
    return v;
  };
  return { dimensions: dim, embed: async (t: string) => vecFor(t), embedBatch: async (t: string[]) => t.map(vecFor) } as unknown as GeminiEmbedder;
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
});
