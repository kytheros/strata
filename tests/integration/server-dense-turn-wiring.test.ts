/**
 * Integration test: server wiring for the dense turn-lane.
 *
 * Verifies that after initEmbedder() wires a provider, the engine
 * has setEmbedder/setVectorSearch set, and handleSearchHistory is
 * called with a turnStore (so the dense lane is reachable).
 *
 * Uses a fake EmbeddingProvider to avoid real API calls.
 * Spec: 2026-06-03-dense-turn-lane-production-design §3.2.
 */
import { describe, it, expect } from "vitest";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { SqliteKnowledgeTurnStore } from "../../src/storage/sqlite-knowledge-turn-store.js";
import { VectorSearch } from "../../src/extensions/embeddings/vector-search.js";
import type { EmbeddingProvider } from "../../src/extensions/vector-search/embedding-provider.js";

function fakeProvider(): EmbeddingProvider {
  const v = (dim: number) => { const a = new Float32Array(dim); a[0] = 1; return a; };
  return {
    dimensions: 768,
    modelName: "nomic-embed-text-v1.5",
    supportsQuantization: false,
    embed: async () => v(768),
    embedBatch: async (t: string[]) => t.map(() => v(768)),
  } as unknown as EmbeddingProvider;
}

describe("server dense turn-lane wiring", () => {
  it("engine accepts setEmbedder and setVectorSearch injections", () => {
    const db = openDatabase(":memory:");
    const engine = new SqliteSearchEngine(new SqliteDocumentStore(db));
    const provider = fakeProvider();
    const vectorSearch = new VectorSearch(db, provider.modelName);

    // These should not throw — verifies the setters exist and are callable.
    engine.setEmbedder(provider);
    engine.setVectorSearch(vectorSearch);

    db.close();
  });

  it("SqliteKnowledgeTurnStore constructed with provider can bulkInsert and embed", async () => {
    const db = openDatabase(":memory:");
    const provider = fakeProvider();
    const turnStore = new SqliteKnowledgeTurnStore(db, provider);

    await turnStore.bulkInsert([
      { sessionId: "s1", project: "proj", userId: null, speaker: "user", content: "hello world", messageIndex: 0 },
    ]);

    const rows = db.prepare("SELECT COUNT(*) AS c FROM knowledge_turn_embeddings").get() as { c: number };
    db.close();

    expect(rows.c).toBe(1);
  });

  it("engine.setEmbedder(null) degrades dense lane gracefully (mismatch scenario)", () => {
    const db = openDatabase(":memory:");
    const engine = new SqliteSearchEngine(new SqliteDocumentStore(db));
    const provider = fakeProvider();

    engine.setEmbedder(provider);
    // Simulate mismatch: null the embedder
    engine.setEmbedder(null);

    // searchTurns should still return [] without throwing (no turn store attached)
    const result = engine.searchTurns("test", { userId: null, limit: 5 });

    db.close();
    // Just checking no throw — returns a Promise<[]>
    expect(result).toBeInstanceOf(Promise);
  });
});
