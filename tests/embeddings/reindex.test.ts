// strata/tests/embeddings/reindex.test.ts
import { describe, it, expect } from "vitest";
import { openDatabase } from "../../src/storage/database.js";
import { reindexEmbeddings } from "../../src/extensions/embeddings/reindex.js";

const fakeEmbedder = {
  modelName: "nomic-embed-text-v1.5",
  dimensions: 768,
  supportsQuantization: false,
  embed: async () => { const v = new Float32Array(768); v[0] = 1; return v; },
  embedBatch: async (texts: string[]) => texts.map(() => { const v = new Float32Array(768); v[0] = 1; return v; }),
};

describe("reindexEmbeddings", () => {
  it("re-embeds entries under the new model while RETAINING old-model vectors", async () => {
    const db = openDatabase(":memory:");
    db.prepare(`INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details)
                VALUES ('e1','fact','p','s',0,'sum','det')`).run();
    // Existing Gemini vector for this entry
    db.prepare(`INSERT INTO embeddings (entry_id, embedding, model, created_at, format)
                VALUES ('e1', ?, 'gemini-embedding-001', 0, 'float32')`).run(Buffer.alloc(12288));

    // Point the active model to nomic via env (resolveActiveEmbeddingModel reads process.env)
    process.env.STRATA_EMBEDDING_PROVIDER = "local";
    try {
      await reindexEmbeddings(db, fakeEmbedder as any);
    } finally {
      delete process.env.STRATA_EMBEDDING_PROVIDER;
    }

    const models = db.prepare("SELECT model FROM embeddings WHERE entry_id='e1' ORDER BY model").all();
    db.close();

    // Both old (gemini) and new (nomic) rows must exist — non-destructive
    expect(models.map((m: any) => m.model)).toEqual(["gemini-embedding-001", "nomic-embed-text-v1.5"]);
  });
});
