import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import { handleStoreMemory } from "../../src/tools/store-memory.js";

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
});
