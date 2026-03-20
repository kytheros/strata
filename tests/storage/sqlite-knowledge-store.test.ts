import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import type { KnowledgeEntry } from "../../src/knowledge/knowledge-store.js";

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2, 8)}`,
    type: "solution",
    project: "test-project",
    sessionId: "session-1",
    timestamp: Date.now(),
    summary: "Fixed the build error",
    details: "The issue was a missing dependency in package.json",
    tags: ["build", "npm"],
    relatedFiles: ["package.json"],
    ...overrides,
  };
}

describe("SqliteKnowledgeStore", () => {
  let db: Database.Database;
  let store: SqliteKnowledgeStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new SqliteKnowledgeStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("addEntry", () => {
    it("should add and retrieve an entry", async () => {
      const entry = makeEntry({ id: "e1" });
      await store.addEntry(entry);

      const result = await store.getEntry("e1");
      expect(result).toBeDefined();
      expect(result!.id).toBe("e1");
      expect(result!.summary).toBe(entry.summary);
      expect(result!.details).toBe(entry.details);
      expect(result!.tags).toEqual(["build", "npm"]);
      expect(result!.relatedFiles).toEqual(["package.json"]);
    });

    it("should skip duplicates by project+type+summary", async () => {
      const entry1 = makeEntry({ id: "e1", project: "proj", type: "solution", summary: "Same" });
      const entry2 = makeEntry({ id: "e2", project: "proj", type: "solution", summary: "Same" });

      await store.addEntry(entry1);
      await store.addEntry(entry2);

      expect(await store.getEntryCount()).toBe(1);
      expect(await store.getEntry("e1")).toBeDefined();
      expect(await store.getEntry("e2")).toBeUndefined();
    });

    it("should allow same summary for different types", async () => {
      await store.addEntry(makeEntry({ id: "e1", type: "solution", summary: "Same summary" }));
      await store.addEntry(makeEntry({ id: "e2", type: "pattern", summary: "Same summary" }));
      expect(await store.getEntryCount()).toBe(2);
    });
  });

  describe("upsertEntry", () => {
    it("should insert a new entry", async () => {
      await store.upsertEntry(makeEntry({ id: "e1" }));
      expect(await store.getEntry("e1")).toBeDefined();
    });

    it("should replace an existing entry by ID", async () => {
      await store.upsertEntry(makeEntry({ id: "e1", summary: "Original" }));
      await store.upsertEntry(makeEntry({ id: "e1", summary: "Updated" }));

      const result = await store.getEntry("e1");
      expect(result!.summary).toBe("Updated");
      expect(await store.getEntryCount()).toBe(1);
    });
  });

  describe("hasEntry", () => {
    it("should return true for existing entry", async () => {
      await store.addEntry(makeEntry({ id: "e1" }));
      expect(await store.hasEntry("e1")).toBe(true);
    });

    it("should return false for non-existent entry", async () => {
      expect(await store.hasEntry("non-existent")).toBe(false);
    });
  });

  describe("search", () => {
    it("should find entries by keyword in summary", async () => {
      await store.addEntry(makeEntry({ id: "e1", summary: "Fixed docker compose issue" }));
      await store.addEntry(makeEntry({ id: "e2", summary: "React component bug" }));

      const results = await store.search("docker");
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("e1");
    });

    it("should find entries by keyword in details", async () => {
      await store.addEntry(makeEntry({ id: "e1", details: "Use kubernetes to deploy" }));
      const results = await store.search("kubernetes");
      expect(results).toHaveLength(1);
    });

    it("should filter by project", async () => {
      await store.addEntry(makeEntry({ id: "e1", project: "proj-a", summary: "Docker fix" }));
      await store.addEntry(makeEntry({ id: "e2", project: "proj-b", summary: "Docker config" }));

      const results = await store.search("docker", "proj-a");
      expect(results).toHaveLength(1);
      expect(results[0].project).toBe("proj-a");
    });
  });

  describe("getProjectEntries", () => {
    it("should return entries for a project", async () => {
      await store.addEntry(makeEntry({ id: "e1", project: "my-project" }));
      await store.addEntry(makeEntry({ id: "e2", project: "other-project" }));

      const results = await store.getProjectEntries("my-project");
      expect(results).toHaveLength(1);
      expect(results[0].project).toBe("my-project");
    });
  });

  describe("getByType", () => {
    it("should return entries of a given type", async () => {
      await store.addEntry(makeEntry({ id: "e1", type: "solution" }));
      await store.addEntry(makeEntry({ id: "e2", type: "pattern" }));
      await store.addEntry(makeEntry({ id: "e3", type: "solution", summary: "different" }));

      const results = await store.getByType("solution");
      expect(results).toHaveLength(2);
    });

    it("should filter by type and project", async () => {
      await store.addEntry(makeEntry({ id: "e1", type: "solution", project: "p1" }));
      await store.addEntry(makeEntry({ id: "e2", type: "solution", project: "p2", summary: "other" }));

      const results = await store.getByType("solution", "p1");
      expect(results).toHaveLength(1);
    });
  });

  describe("getGlobalLearnings", () => {
    it("should return learning entries sorted by occurrences", async () => {
      await store.addEntry(makeEntry({ id: "e1", type: "learning", summary: "L1", occurrences: 5 }));
      await store.addEntry(makeEntry({ id: "e2", type: "learning", summary: "L2", occurrences: 10 }));
      await store.addEntry(makeEntry({ id: "e3", type: "solution", summary: "Not a learning" }));

      const results = await store.getGlobalLearnings();
      expect(results).toHaveLength(2);
      expect(results[0].occurrences).toBe(10);
      expect(results[1].occurrences).toBe(5);
    });
  });

  describe("removeEntry", () => {
    it("should remove an entry", async () => {
      await store.addEntry(makeEntry({ id: "e1" }));
      await store.removeEntry("e1");
      expect(await store.getEntry("e1")).toBeUndefined();
      expect(await store.getEntryCount()).toBe(0);
    });
  });

  describe("getAllEntries", () => {
    it("should return all entries", async () => {
      await store.addEntry(makeEntry({ id: "e1", summary: "S1" }));
      await store.addEntry(makeEntry({ id: "e2", summary: "S2" }));
      expect(await store.getAllEntries()).toHaveLength(2);
    });
  });

  describe("optional fields", () => {
    it("should handle entries without optional fields", async () => {
      const entry = makeEntry({
        id: "e1",
        occurrences: undefined,
        projectCount: undefined,
        extractedAt: undefined,
      });
      await store.addEntry(entry);

      const result = await store.getEntry("e1");
      expect(result!.occurrences).toBeUndefined();
      expect(result!.projectCount).toBeUndefined();
      expect(result!.extractedAt).toBeUndefined();
    });
  });
});
