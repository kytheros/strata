// strata/tests/storage/turn-store-embeddings.test.ts
import { describe, it, expect } from "vitest";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteKnowledgeTurnStore } from "../../src/storage/sqlite-knowledge-turn-store.js";
import type { EmbeddingProvider } from "../../src/extensions/vector-search/embedding-provider.js";

// Updated to EmbeddingProvider interface (T4: turn store adopts EmbeddingProvider contracts).
function fakeEmbedder(dim = 3072): EmbeddingProvider {
  const v = () => { const a = new Float32Array(dim); a[0] = 1; return a; };
  return {
    dimensions: dim,
    modelName: "gemini-embedding-001",
    supportsQuantization: false,
    embed: async () => v(),
    embedBatch: async (t: string[]) => t.map(v),
  } as unknown as EmbeddingProvider;
}
const countEmb = (db: any) =>
  (db.prepare("SELECT COUNT(*) AS c FROM knowledge_turn_embeddings").get() as { c: number }).c;

describe("SqliteKnowledgeTurnStore embeddings", () => {
  it("writes one embedding row per turn on bulkInsert when an embedder is present", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteKnowledgeTurnStore(db, fakeEmbedder());
    await store.bulkInsert([
      { sessionId: "s1", speaker: "user", content: "hello", messageIndex: 0 },
      { sessionId: "s1", speaker: "assistant", content: "hi there", messageIndex: 1 },
    ]);
    expect(countEmb(db)).toBe(2);
    db.close();
  });

  it("writes NO embeddings when no embedder is passed (byte-identical to today)", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteKnowledgeTurnStore(db); // no embedder
    await store.bulkInsert([{ sessionId: "s1", speaker: "user", content: "hello", messageIndex: 0 }]);
    expect(countEmb(db)).toBe(0);
    db.close();
  });

  it("getByIds returns the rows for the given turn_ids", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteKnowledgeTurnStore(db);
    const [id0, id1] = await store.bulkInsert([
      { sessionId: "s1", speaker: "user", content: "a", messageIndex: 0 },
      { sessionId: "s1", speaker: "assistant", content: "b", messageIndex: 1 },
    ]);
    const rows = await store.getByIds([id1, id0]);
    expect(rows.map((r) => r.turnId).sort()).toEqual([id0, id1].sort());
    db.close();
  });

  it("deleteBySessionId removes both turn rows and their embeddings", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteKnowledgeTurnStore(db, fakeEmbedder());
    await store.bulkInsert([{ sessionId: "s1", speaker: "user", content: "x", messageIndex: 0 }]);
    expect(countEmb(db)).toBe(1);
    await store.deleteBySessionId("s1");
    expect(countEmb(db)).toBe(0);
    expect(await store.count()).toBe(0);
    db.close();
  });

  it("skips embedding rows for empty/whitespace-only turn content; non-empty turns still embed (FIX 2)", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteKnowledgeTurnStore(db, fakeEmbedder());
    // Mix of empty, whitespace, and real content — embedder should only be called for real content.
    await store.bulkInsert([
      { sessionId: "s1", speaker: "user", content: "",          messageIndex: 0 },
      { sessionId: "s1", speaker: "assistant", content: "  \t\n  ", messageIndex: 1 },
      { sessionId: "s1", speaker: "user", content: "hello world", messageIndex: 2 },
      { sessionId: "s1", speaker: "assistant", content: "goodbye", messageIndex: 3 },
    ]);
    // 4 turns inserted, but only 2 have non-empty content → only 2 embedding rows.
    expect(await store.count()).toBe(4);    // all turn rows present
    expect(countEmb(db)).toBe(2);           // only non-empty turns embedded
    db.close();
  });

  it("does NOT throw when ALL turns in a batch are empty content", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteKnowledgeTurnStore(db, fakeEmbedder());
    await expect(store.bulkInsert([
      { sessionId: "s1", speaker: "user", content: "", messageIndex: 0 },
      { sessionId: "s1", speaker: "user", content: "   ", messageIndex: 1 },
    ])).resolves.not.toThrow();
    expect(countEmb(db)).toBe(0); // no embeddings for empty content
    db.close();
  });
});
