import { describe, it, expect } from "vitest";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteKnowledgeTurnStore } from "../../src/storage/sqlite-knowledge-turn-store.js";
import type { EmbeddingProvider } from "../../src/extensions/vector-search/embedding-provider.js";

/**
 * Fake non-Gemini provider with 768-dim vectors and supportsQuantization=false.
 * This asserts that the turn store uses encodeEmbeddingFor (provider-gated
 * quantization) rather than the old encodeEmbedding (global-flag-only).
 */
function fakeProvider(): EmbeddingProvider {
  const v = () => { const a = new Float32Array(768); a[0] = 1; return a; };
  return {
    dimensions: 768,
    modelName: "nomic-embed-text-v1.5",
    supportsQuantization: false,
    embed: async () => v(),
    embedBatch: async (t: string[]) => t.map(v),
  } as unknown as EmbeddingProvider;
}

describe("SqliteKnowledgeTurnStore — EmbeddingProvider contracts", () => {
  it("stamps provider.modelName and uses format=float32 for non-quantizing provider", async () => {
    const db = openDatabase(":memory:");
    const provider = fakeProvider();
    const store = new SqliteKnowledgeTurnStore(db, provider);

    await store.bulkInsert([
      { sessionId: "s1", project: "proj", userId: null, speaker: "user", content: "hello world", messageIndex: 0 },
      { sessionId: "s1", project: "proj", userId: null, speaker: "assistant", content: "hi there", messageIndex: 1 },
    ]);

    const rows = db.prepare("SELECT model, format FROM knowledge_turn_embeddings").all() as { model: string; format: string }[];
    db.close();

    expect(rows.length).toBe(2);
    for (const row of rows) {
      // Must stamp the provider's model name (not the hard-coded "gemini-embedding-001")
      expect(row.model).toBe("nomic-embed-text-v1.5");
      // Non-quantizing provider must produce float32 (not tq4 or other quantized format)
      expect(row.format).toBe("float32");
    }
  });
});
