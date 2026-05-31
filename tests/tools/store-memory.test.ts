import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import { DocumentChunkStore } from "../../src/storage/document-chunk-store.js";
import { handleStoreMemory } from "../../src/tools/store-memory.js";
import { CONFIG } from "../../src/config.js";

// Mock the gemini provider to return null (no LLM available in tests)
vi.mock("../../src/extensions/llm-extraction/gemini-provider.js", () => ({
  getCachedGeminiProvider: vi.fn().mockResolvedValue(null),
}));

describe("store_memory tool", () => {
  let db: Database.Database;
  let store: SqliteKnowledgeStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new SqliteKnowledgeStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("stores a decision memory", async () => {
    const result = await handleStoreMemory(store, {
      memory: "Always run migrations before seeding the database",
      type: "decision",
    });

    expect(result).toContain("Stored decision");
    expect(result).toContain("Always run migrations before seeding");
    expect(await store.getEntryCount()).toBe(1);
  });

  it("stores a solution memory with tags", async () => {
    const result = await handleStoreMemory(store, {
      memory: "Fix Docker build by clearing cache with --no-cache flag",
      type: "solution",
      tags: ["docker", "build"],
    });

    expect(result).toContain("Stored solution");
    expect(result).toContain("[tags: docker, build]");
    expect(await store.getEntryCount()).toBe(1);

    const entries = await store.getAllEntries();
    expect(entries[0].tags).toEqual(["docker", "build"]);
  });

  it("stores a pattern memory with project", async () => {
    const result = await handleStoreMemory(store, {
      memory: "Use factory test builders with makeX(overrides) pattern",
      type: "pattern",
      project: "my-project",
    });

    expect(result).toContain("Stored pattern");
    expect(await store.getEntryCount()).toBe(1);

    const entries = await store.getAllEntries();
    expect(entries[0].project).toBe("my-project");
  });

  it("stored memory is immediately searchable", async () => {
    await handleStoreMemory(store, {
      memory: "Use bun instead of npm for package management",
      type: "decision",
      tags: ["tooling"],
    });

    // SqliteKnowledgeStore.search does LIKE matching on individual terms
    const results = await store.search("bun");
    expect(results.length).toBe(1);
    expect(results[0].summary).toContain("bun instead of npm");
  });

  it("rejects empty memory", async () => {
    const result = await handleStoreMemory(store, {
      memory: "",
      type: "decision",
    });

    expect(result).toContain("Error");
    expect(await store.getEntryCount()).toBe(0);
  });

  it("rejects too-short memory", async () => {
    const result = await handleStoreMemory(store, {
      memory: "hi",
      type: "decision",
    });

    expect(result).toContain("Error");
    expect(await store.getEntryCount()).toBe(0);
  });

  it("defaults project to global when not specified", async () => {
    await handleStoreMemory(store, {
      memory: "A globally applicable decision about coding standards",
      type: "decision",
    });

    const entries = await store.getAllEntries();
    expect(entries[0].project).toBe("global");
  });

  it("truncates long memory summary to 200 chars", async () => {
    const longMemory = "A".repeat(300);
    await handleStoreMemory(store, {
      memory: longMemory,
      type: "pattern",
    });

    const entries = await store.getAllEntries();
    expect(entries[0].summary.length).toBe(200);
    expect(entries[0].details.length).toBe(300);
  });

  it("deduplicates identical memories", async () => {
    await handleStoreMemory(store, {
      memory: "Use TypeScript strict mode",
      type: "decision",
    });
    await handleStoreMemory(store, {
      memory: "Use TypeScript strict mode",
      type: "decision",
    });

    expect(await store.getEntryCount()).toBe(1);
  });

  // ── chunk-indexing tests ─────────────────────────────────────────────

  describe("chunk indexing for long memories", () => {
    let chunkDb: Database.Database;
    let chunkStore: DocumentChunkStore;
    const mockEmbedder = {
      embedText: vi.fn().mockResolvedValue(new Float32Array(3072).fill(0.1)),
      embedBinary: vi.fn(),
      dimensions: 3072,
    };

    beforeEach(() => {
      chunkDb = openDatabase(":memory:");
      chunkStore = new DocumentChunkStore(chunkDb);
      mockEmbedder.embedText.mockClear();
    });

    afterEach(() => {
      chunkDb.close();
    });

    it("chunks long details into DocumentChunkStore with derived sessionId", async () => {
      // Produce a details string longer than the threshold (default 800)
      const longDetails = "Paragraph about the decision. ".repeat(40); // ~1200 chars
      expect(longDetails.length).toBeGreaterThan(CONFIG.indexing.storeMemoryChunkThreshold);

      const result = await handleStoreMemory(
        store,
        { memory: longDetails, type: "decision" },
        db,
        undefined,
        chunkStore,
        mockEmbedder as any
      );

      expect(result).toContain("Stored decision");

      // The atomic knowledge entry must still be written
      expect(await store.getEntryCount()).toBe(1);

      // At least one chunk must have been stored in the document chunk store
      const docs = chunkDb.prepare("SELECT * FROM stored_documents").all() as Array<{ id: string }>;
      expect(docs.length).toBe(1);

      // The sessionId stored as the document title must be the derived explicit-memory:<id>
      const entries = await store.getAllEntries();
      const knowledgeId = entries[0].id;
      const docRow = docs[0] as { id: string; title: string };
      expect((docs[0] as any).title).toBe(`explicit-memory:${knowledgeId}`);

      // embedder must have been called for chunking
      expect(mockEmbedder.embedText).toHaveBeenCalled();
    });

    it("does NOT chunk short details (≤ threshold) — back-compat", async () => {
      const shortMemory = "Use bun for package management"; // well under 800
      expect(shortMemory.length).toBeLessThanOrEqual(CONFIG.indexing.storeMemoryChunkThreshold);

      await handleStoreMemory(
        store,
        { memory: shortMemory, type: "decision" },
        db,
        undefined,
        chunkStore,
        mockEmbedder as any
      );

      // Atomic entry written
      expect(await store.getEntryCount()).toBe(1);

      // NO chunk store writes
      const docs = chunkDb.prepare("SELECT * FROM stored_documents").all();
      expect(docs).toHaveLength(0);
      expect(mockEmbedder.embedText).not.toHaveBeenCalled();
    });

    it("is a no-op when documentChunkStore is absent — back-compat", async () => {
      const longDetails = "Paragraph about the decision. ".repeat(40);

      // Pass NO chunkStore — should not throw, atomic entry still written
      const result = await handleStoreMemory(
        store,
        { memory: longDetails, type: "decision" },
        db
        // no chunkStore, no embedder
      );

      expect(result).toContain("Stored decision");
      expect(await store.getEntryCount()).toBe(1);
    });

    it("still stores atomic entry even if embedding fails (best-effort)", async () => {
      const failingEmbedder = {
        embedText: vi.fn().mockRejectedValue(new Error("429 rate limit")),
        embedBinary: vi.fn(),
        dimensions: 3072,
      };
      const longDetails = "Paragraph about the decision. ".repeat(40);

      const result = await handleStoreMemory(
        store,
        { memory: longDetails, type: "decision" },
        db,
        undefined,
        chunkStore,
        failingEmbedder as any
      );

      // Memory storage must succeed even when embedding fails
      expect(result).toContain("Stored decision");
      expect(await store.getEntryCount()).toBe(1);
    });
  });
});
