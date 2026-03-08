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
    it("should add a document and retrieve by ID", () => {
      const id = store.add("hello world", 2, makeMetadata());
      const doc = store.get(id);

      expect(doc).toBeDefined();
      expect(doc!.id).toBe(id);
      expect(doc!.text).toBe("hello world");
      expect(doc!.tokenCount).toBe(2);
      expect(doc!.sessionId).toBe("session-1");
      expect(doc!.project).toBe("test-project");
      expect(doc!.role).toBe("user");
    });

    it("should return undefined for non-existent ID", () => {
      expect(store.get("non-existent")).toBeUndefined();
    });

    it("should generate unique IDs", () => {
      const id1 = store.add("doc1", 1, makeMetadata());
      const id2 = store.add("doc2", 1, makeMetadata());
      expect(id1).not.toBe(id2);
    });

    it("should store tool names as JSON array", () => {
      const id = store.add("text", 1, makeMetadata({ toolNames: ["Read", "Write", "Edit"] }));
      const doc = store.get(id);
      expect(doc!.toolNames).toEqual(["Read", "Write", "Edit"]);
    });

    it("should handle empty tool names", () => {
      const id = store.add("text", 1, makeMetadata({ toolNames: [] }));
      const doc = store.get(id);
      expect(doc!.toolNames).toEqual([]);
    });

    it("should store the tool field", () => {
      const id = store.add("text", 1, makeMetadata(), "codex");
      // Tool is stored but not exposed through DocumentChunk interface directly.
      // We can verify by querying the raw row.
      const row = db.prepare("SELECT tool FROM documents WHERE id = ?").get(id) as { tool: string };
      expect(row.tool).toBe("codex");
    });
  });

  describe("getBySession", () => {
    it("should return documents for a session ordered by message_index", () => {
      store.add("msg 2", 2, makeMetadata({ messageIndex: 1 }));
      store.add("msg 1", 2, makeMetadata({ messageIndex: 0 }));
      store.add("other session", 2, makeMetadata({ sessionId: "session-2", messageIndex: 0 }));

      const docs = store.getBySession("session-1");
      expect(docs).toHaveLength(2);
      expect(docs[0].messageIndex).toBe(0);
      expect(docs[1].messageIndex).toBe(1);
    });

    it("should return empty array for unknown session", () => {
      expect(store.getBySession("non-existent")).toEqual([]);
    });
  });

  describe("getByProject", () => {
    it("should return documents for a project", () => {
      store.add("proj1 doc", 2, makeMetadata({ project: "project-a" }));
      store.add("proj2 doc", 2, makeMetadata({ project: "project-b" }));

      const docs = store.getByProject("project-a");
      expect(docs).toHaveLength(1);
      expect(docs[0].project).toBe("project-a");
    });
  });

  describe("remove", () => {
    it("should remove a document by ID", () => {
      const id = store.add("text", 1, makeMetadata());
      expect(store.get(id)).toBeDefined();

      store.remove(id);
      expect(store.get(id)).toBeUndefined();
    });

    it("should not throw when removing non-existent ID", () => {
      expect(() => store.remove("non-existent")).not.toThrow();
    });
  });

  describe("removeSession", () => {
    it("should remove all documents for a session", () => {
      store.add("doc1", 1, makeMetadata({ sessionId: "s1" }));
      store.add("doc2", 1, makeMetadata({ sessionId: "s1" }));
      store.add("doc3", 1, makeMetadata({ sessionId: "s2" }));

      store.removeSession("s1");

      expect(store.getBySession("s1")).toEqual([]);
      expect(store.getBySession("s2")).toHaveLength(1);
    });
  });

  describe("search (FTS5)", () => {
    it("should find documents by keyword", () => {
      store.add("docker compose configuration guide", 4, makeMetadata());
      store.add("react component lifecycle", 3, makeMetadata());
      store.add("typescript generics tutorial", 3, makeMetadata());

      const results = store.search("docker");
      expect(results).toHaveLength(1);
      expect(results[0].chunk.text).toContain("docker");
      expect(typeof results[0].rank).toBe("number");
    });

    it("should return empty array for no matches", () => {
      store.add("hello world", 2, makeMetadata());
      const results = store.search("nonexistentterm");
      expect(results).toEqual([]);
    });

    it("should respect limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        store.add(`document about testing number ${i}`, 5, makeMetadata({ messageIndex: i }));
      }

      const results = store.search("testing", 3);
      expect(results).toHaveLength(3);
    });

    it("should handle empty query gracefully", () => {
      store.add("some text", 2, makeMetadata());
      const results = store.search("");
      expect(results).toEqual([]);
    });

    it("should handle special characters in query", () => {
      store.add("error in file path/to/file.ts", 5, makeMetadata());
      const results = store.search("file.ts");
      // Should not crash, may or may not find results depending on tokenization
      expect(Array.isArray(results)).toBe(true);
    });

    it("should rank more relevant documents higher", () => {
      store.add("docker docker docker compose setup", 5, makeMetadata({ messageIndex: 0 }));
      store.add("quick mention of docker", 4, makeMetadata({ messageIndex: 1 }));

      const results = store.search("docker");
      expect(results.length).toBeGreaterThanOrEqual(2);
      // BM25 rank is negative; more negative = more relevant
      expect(results[0].rank).toBeLessThanOrEqual(results[1].rank);
    });
  });

  describe("getDocumentCount", () => {
    it("should return 0 for empty store", () => {
      expect(store.getDocumentCount()).toBe(0);
    });

    it("should return correct count", () => {
      store.add("doc1", 1, makeMetadata());
      store.add("doc2", 1, makeMetadata());
      expect(store.getDocumentCount()).toBe(2);
    });
  });

  describe("getAverageTokenCount", () => {
    it("should return 0 for empty store", () => {
      expect(store.getAverageTokenCount()).toBe(0);
    });

    it("should compute correct average", () => {
      store.add("doc1", 10, makeMetadata());
      store.add("doc2", 20, makeMetadata());
      expect(store.getAverageTokenCount()).toBe(15);
    });
  });

  describe("getAllDocuments", () => {
    it("should return all documents", () => {
      store.add("doc1", 1, makeMetadata());
      store.add("doc2", 1, makeMetadata());
      const all = store.getAllDocuments();
      expect(all).toHaveLength(2);
    });
  });

  describe("getSessionIds", () => {
    it("should return unique session IDs", () => {
      store.add("d1", 1, makeMetadata({ sessionId: "s1" }));
      store.add("d2", 1, makeMetadata({ sessionId: "s1" }));
      store.add("d3", 1, makeMetadata({ sessionId: "s2" }));

      const ids = store.getSessionIds();
      expect(ids.size).toBe(2);
      expect(ids.has("s1")).toBe(true);
      expect(ids.has("s2")).toBe(true);
    });
  });

  describe("getProjects", () => {
    it("should return unique project names", () => {
      store.add("d1", 1, makeMetadata({ project: "proj-a" }));
      store.add("d2", 1, makeMetadata({ project: "proj-b" }));
      store.add("d3", 1, makeMetadata({ project: "proj-a" }));

      const projects = store.getProjects();
      expect(projects.size).toBe(2);
      expect(projects.has("proj-a")).toBe(true);
      expect(projects.has("proj-b")).toBe(true);
    });
  });
});
