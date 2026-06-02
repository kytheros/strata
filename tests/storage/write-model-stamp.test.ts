// strata/tests/storage/write-model-stamp.test.ts
//
// Behavioral assertions for write-path model stamping.
// Covers: (1) non-Gemini model name stamped correctly, (2) Gemini provider still quantizes.
import { describe, it, expect, afterEach } from "vitest";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";

const BASE_ENTRY = {
  id: "e1",
  type: "fact" as const,
  project: "p",
  sessionId: "s",
  timestamp: 0,
  summary: "sum",
  details: "det",
  tags: [],
  relatedFiles: [],
};

afterEach(() => {
  delete process.env.STRATA_EMBEDDING_PROVIDER;
  delete process.env.STRATA_EMBEDDING_MODEL;
});

describe("write-path model stamping — behavioral", () => {
  it("stamps nomic-embed-text-v1.5 when provider=local and fake embedder reports that model", async () => {
    // Arrange: set env to local, construct store with a fake local-compatible embedder
    process.env.STRATA_EMBEDDING_PROVIDER = "local";

    const fakeVec = new Float32Array(768); fakeVec[0] = 1;
    const fakeEmbedder = {
      modelName: "nomic-embed-text-v1.5",
      dimensions: 768,
      supportsQuantization: false,
      embed: async () => fakeVec,
      embedBatch: async (texts: string[]) => texts.map(() => fakeVec),
    };

    const db = openDatabase(":memory:");
    const store = new SqliteKnowledgeStore(db, fakeEmbedder as any);

    // Act: add an entry (triggers embedEntryAsync)
    await store.addEntry(BASE_ENTRY);
    await store.flushPendingEmbeddings();

    // Assert: row in embeddings has the correct model name and raw format (no quantization)
    const row = db.prepare("SELECT model, format FROM embeddings WHERE entry_id = 'e1'").get() as any;
    db.close();

    expect(row).toBeDefined();
    expect(row.model).toBe("nomic-embed-text-v1.5");
    expect(row.format).toBe("float32"); // non-Gemini provider must not quantize
  });

  it("Gemini provider still quantizes (supportsQuantization=true → format=tq4)", async () => {
    // Default env: provider=gemini
    const fakeVec = new Float32Array(3072); fakeVec[0] = 1;
    const fakeGeminiProvider = {
      modelName: "gemini-embedding-001",
      dimensions: 3072,
      supportsQuantization: true, // Gemini wraps with this flag (T2)
      embed: async () => fakeVec,
      embedBatch: async (texts: string[]) => texts.map(() => fakeVec),
    };

    const db = openDatabase(":memory:");
    const store = new SqliteKnowledgeStore(db, fakeGeminiProvider as any);

    await store.addEntry({ ...BASE_ENTRY, id: "e2" });
    await store.flushPendingEmbeddings();

    const row = db.prepare("SELECT model, format FROM embeddings WHERE entry_id = 'e2'").get() as any;
    db.close();

    expect(row).toBeDefined();
    expect(row.model).toBe("gemini-embedding-001");
    // CONFIG.quantization.enabled=true + supportsQuantization=true → should be quantized
    expect(row.format).toMatch(/^tq\d$/); // tq4 (or tq1/tq2/tq8)
  });
});
