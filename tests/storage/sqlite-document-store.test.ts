import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import type { DocumentMetadata } from "../../src/indexing/document-store.js";

function makeMetadata(overrides: Partial<DocumentMetadata> = {}): DocumentMetadata {
  return {
    sessionId: "session-1",
    project: "test-project",
    role: "user",
    timestamp: Date.now(),
    toolNames: [],
    messageIndex: 0,
    ...overrides,
  };
}

describe("SqliteDocumentStore", () => {
  let db: Database.Database;
  let store: SqliteDocumentStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new SqliteDocumentStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("add and get", () => {
    it("should add a document and retrieve by ID", async () => {
      const id = await store.add("hello world", 2, makeMetadata());
      const doc = await store.get(id);

      expect(doc).toBeDefined();
      expect(doc!.id).toBe(id);
      expect(doc!.text).toBe("hello world");
      expect(doc!.tokenCount).toBe(2);
      expect(doc!.sessionId).toBe("session-1");
      expect(doc!.project).toBe("test-project");
      expect(doc!.role).toBe("user");
    });

    it("should return undefined for non-existent ID", async () => {
      expect(await store.get("non-existent")).toBeUndefined();
    });

    it("should generate unique IDs", async () => {
      const id1 = await store.add("doc1", 1, makeMetadata());
      const id2 = await store.add("doc2", 1, makeMetadata());
      expect(id1).not.toBe(id2);
    });

    it("should store tool names as JSON array", async () => {
      const id = await store.add("text", 1, makeMetadata({ toolNames: ["Read", "Write", "Edit"] }));
      const doc = await store.get(id);
      expect(doc!.toolNames).toEqual(["Read", "Write", "Edit"]);
    });

    it("should handle empty tool names", async () => {
      const id = await store.add("text", 1, makeMetadata({ toolNames: [] }));
      const doc = await store.get(id);
      expect(doc!.toolNames).toEqual([]);
    });

    it("should store the tool field", async () => {
      const id = await store.add("text", 1, makeMetadata(), "codex");
      // Tool is stored but not exposed through DocumentChunk interface directly.
      // We can verify by querying the raw row.
      const row = db.prepare("SELECT tool FROM documents WHERE id = ?").get(id) as { tool: string };
      expect(row.tool).toBe("codex");
    });
  });

  describe("getBySession", () => {
    it("should return documents for a session ordered by message_index", async () => {
      await store.add("msg 2", 2, makeMetadata({ messageIndex: 1 }));
      await store.add("msg 1", 2, makeMetadata({ messageIndex: 0 }));
      await store.add("other session", 2, makeMetadata({ sessionId: "session-2", messageIndex: 0 }));

      const docs = await store.getBySession("session-1");
      expect(docs).toHaveLength(2);
      expect(docs[0].messageIndex).toBe(0);
      expect(docs[1].messageIndex).toBe(1);
    });

    it("should return empty array for unknown session", async () => {
      expect(await store.getBySession("non-existent")).toEqual([]);
    });
  });

  describe("getByProject", () => {
    it("should return documents for a project", async () => {
      await store.add("proj1 doc", 2, makeMetadata({ project: "project-a" }));
      await store.add("proj2 doc", 2, makeMetadata({ project: "project-b" }));

      const docs = await store.getByProject("project-a");
      expect(docs).toHaveLength(1);
      expect(docs[0].project).toBe("project-a");
    });
  });

  describe("remove", () => {
    it("should remove a document by ID", async () => {
      const id = await store.add("text", 1, makeMetadata());
      expect(await store.get(id)).toBeDefined();

      await store.remove(id);
      expect(await store.get(id)).toBeUndefined();
    });

    it("should not throw when removing non-existent ID", async () => {
      await store.remove("non-existent"); // should not throw
    });
  });

  describe("removeSession", () => {
    it("should remove all documents for a session", async () => {
      await store.add("doc1", 1, makeMetadata({ sessionId: "s1" }));
      await store.add("doc2", 1, makeMetadata({ sessionId: "s1" }));
      await store.add("doc3", 1, makeMetadata({ sessionId: "s2" }));

      await store.removeSession("s1");

      expect(await store.getBySession("s1")).toEqual([]);
      expect(await store.getBySession("s2")).toHaveLength(1);
    });
  });

  describe("search (FTS5)", () => {
    it("should find documents by keyword", async () => {
      await store.add("docker compose configuration guide", 4, makeMetadata());
      await store.add("react component lifecycle", 3, makeMetadata());
      await store.add("typescript generics tutorial", 3, makeMetadata());

      const results = await store.search("docker");
      expect(results).toHaveLength(1);
      expect(results[0].chunk.text).toContain("docker");
      expect(typeof results[0].rank).toBe("number");
    });

    it("should return empty array for no matches", async () => {
      await store.add("hello world", 2, makeMetadata());
      const results = await store.search("nonexistentterm");
      expect(results).toEqual([]);
    });

    it("should respect limit parameter", async () => {
      for (let i = 0; i < 10; i++) {
        await store.add(`document about testing number ${i}`, 5, makeMetadata({ messageIndex: i }));
      }

      const results = await store.search("testing", 3);
      expect(results).toHaveLength(3);
    });

    it("should handle empty query gracefully", async () => {
      await store.add("some text", 2, makeMetadata());
      const results = await store.search("");
      expect(results).toEqual([]);
    });

    it("should handle special characters in query", async () => {
      await store.add("error in file path/to/file.ts", 5, makeMetadata());
      const results = await store.search("file.ts");
      // Should not crash, may or may not find results depending on tokenization
      expect(Array.isArray(results)).toBe(true);
    });

    it("should rank more relevant documents higher", async () => {
      await store.add("docker docker docker compose setup", 5, makeMetadata({ messageIndex: 0 }));
      await store.add("quick mention of docker", 4, makeMetadata({ messageIndex: 1 }));

      const results = await store.search("docker");
      expect(results.length).toBeGreaterThanOrEqual(2);
      // BM25 rank is negative; more negative = more relevant
      expect(results[0].rank).toBeLessThanOrEqual(results[1].rank);
    });
  });

  describe("getDocumentCount", () => {
    it("should return 0 for empty store", async () => {
      expect(await store.getDocumentCount()).toBe(0);
    });

    it("should return correct count", async () => {
      await store.add("doc1", 1, makeMetadata());
      await store.add("doc2", 1, makeMetadata());
      expect(await store.getDocumentCount()).toBe(2);
    });
  });

  describe("getAverageTokenCount", () => {
    it("should return 0 for empty store", async () => {
      expect(await store.getAverageTokenCount()).toBe(0);
    });

    it("should compute correct average", async () => {
      await store.add("doc1", 10, makeMetadata());
      await store.add("doc2", 20, makeMetadata());
      expect(await store.getAverageTokenCount()).toBe(15);
    });
  });

  describe("getAllDocuments", () => {
    it("should return all documents", async () => {
      await store.add("doc1", 1, makeMetadata());
      await store.add("doc2", 1, makeMetadata());
      const all = await store.getAllDocuments();
      expect(all).toHaveLength(2);
    });
  });

  describe("getSessionIds", () => {
    it("should return unique session IDs", async () => {
      await store.add("d1", 1, makeMetadata({ sessionId: "s1" }));
      await store.add("d2", 1, makeMetadata({ sessionId: "s1" }));
      await store.add("d3", 1, makeMetadata({ sessionId: "s2" }));

      const ids = await store.getSessionIds();
      expect(ids.size).toBe(2);
      expect(ids.has("s1")).toBe(true);
      expect(ids.has("s2")).toBe(true);
    });
  });

  describe("getProjects", () => {
    it("should return unique project names", async () => {
      await store.add("d1", 1, makeMetadata({ project: "proj-a" }));
      await store.add("d2", 1, makeMetadata({ project: "proj-b" }));
      await store.add("d3", 1, makeMetadata({ project: "proj-a" }));

      const projects = await store.getProjects();
      expect(projects.size).toBe(2);
      expect(projects.has("proj-a")).toBe(true);
      expect(projects.has("proj-b")).toBe(true);
    });
  });
});
