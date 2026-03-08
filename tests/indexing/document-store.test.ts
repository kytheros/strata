import { describe, it, expect, beforeEach } from "vitest";
import { DocumentStore } from "../../src/indexing/document-store.js";

function makeMetadata(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-1",
    project: "test-project",
    role: "user" as const,
    timestamp: Date.now(),
    toolNames: [],
    messageIndex: 0,
    ...overrides,
  };
}

describe("DocumentStore", () => {
  let store: DocumentStore;

  beforeEach(() => {
    store = new DocumentStore();
  });

  describe("CRUD operations", () => {
    it("should add and retrieve a document", () => {
      const id = store.addDocument("hello world", 2, makeMetadata());
      const doc = store.getDocument(id);

      expect(doc).toBeDefined();
      expect(doc!.text).toBe("hello world");
      expect(doc!.tokenCount).toBe(2);
      expect(doc!.id).toBe(id);
    });

    it("should return string IDs", () => {
      const id = store.addDocument("test", 1, makeMetadata());
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    });

    it("should return undefined for missing ID", () => {
      expect(store.getDocument("nonexistent")).toBeUndefined();
    });

    it("should track document count", () => {
      expect(store.getDocumentCount()).toBe(0);
      store.addDocument("a", 1, makeMetadata());
      expect(store.getDocumentCount()).toBe(1);
      store.addDocument("b", 1, makeMetadata());
      expect(store.getDocumentCount()).toBe(2);
    });

    it("should compute average token count", () => {
      store.addDocument("a", 10, makeMetadata());
      store.addDocument("b", 20, makeMetadata());
      expect(store.getAverageTokenCount()).toBe(15);
    });

    it("should return 0 average for empty store", () => {
      expect(store.getAverageTokenCount()).toBe(0);
    });
  });

  describe("session operations", () => {
    it("should filter documents by session", () => {
      store.addDocument("a", 1, makeMetadata({ sessionId: "s1" }));
      store.addDocument("b", 1, makeMetadata({ sessionId: "s2" }));
      store.addDocument("c", 1, makeMetadata({ sessionId: "s1" }));

      const s1Docs = store.getSessionDocuments("s1");
      expect(s1Docs.length).toBe(2);
      expect(s1Docs.every((d) => d.sessionId === "s1")).toBe(true);
    });

    it("should remove session without breaking other lookups", () => {
      const id1 = store.addDocument("a", 1, makeMetadata({ sessionId: "s1" }));
      const id2 = store.addDocument("b", 1, makeMetadata({ sessionId: "s2" }));
      const id3 = store.addDocument("c", 1, makeMetadata({ sessionId: "s1" }));

      store.removeSession("s1");

      expect(store.getDocumentCount()).toBe(1);
      expect(store.getDocument(id1)).toBeUndefined();
      expect(store.getDocument(id3)).toBeUndefined();
      // id2 should still be accessible
      expect(store.getDocument(id2)).toBeDefined();
      expect(store.getDocument(id2)!.text).toBe("b");
    });

    it("should return unique session IDs", () => {
      store.addDocument("a", 1, makeMetadata({ sessionId: "s1" }));
      store.addDocument("b", 1, makeMetadata({ sessionId: "s2" }));
      store.addDocument("c", 1, makeMetadata({ sessionId: "s1" }));

      const ids = store.getSessionIds();
      expect(ids.size).toBe(2);
      expect(ids.has("s1")).toBe(true);
      expect(ids.has("s2")).toBe(true);
    });
  });

  describe("project operations", () => {
    it("should filter documents by project", () => {
      store.addDocument("a", 1, makeMetadata({ project: "proj-a" }));
      store.addDocument("b", 1, makeMetadata({ project: "proj-b" }));

      const docs = store.getProjectDocuments("proj-a");
      expect(docs.length).toBe(1);
      expect(docs[0].project).toBe("proj-a");
    });

    it("should return unique projects", () => {
      store.addDocument("a", 1, makeMetadata({ project: "p1" }));
      store.addDocument("b", 1, makeMetadata({ project: "p2" }));
      store.addDocument("c", 1, makeMetadata({ project: "p1" }));

      const projects = store.getProjects();
      expect(projects.size).toBe(2);
    });
  });

  describe("serialization", () => {
    it("should round-trip serialize/deserialize", () => {
      const id1 = store.addDocument("hello", 1, makeMetadata({ sessionId: "s1" }));
      const id2 = store.addDocument("world", 2, makeMetadata({ sessionId: "s2" }));

      const serialized = store.serialize();
      const restored = DocumentStore.deserialize(serialized);

      expect(restored.getDocumentCount()).toBe(2);
      expect(restored.getDocument(id1)!.text).toBe("hello");
      expect(restored.getDocument(id2)!.text).toBe("world");
    });

    it("should preserve all fields through serialization", () => {
      const meta = makeMetadata({
        sessionId: "sess-42",
        project: "my-project",
        role: "assistant",
        toolNames: ["Bash", "Read"],
        messageIndex: 5,
      });
      const id = store.addDocument("test content", 10, meta);

      const restored = DocumentStore.deserialize(store.serialize());
      const doc = restored.getDocument(id)!;

      expect(doc.sessionId).toBe("sess-42");
      expect(doc.project).toBe("my-project");
      expect(doc.role).toBe("assistant");
      expect(doc.toolNames).toEqual(["Bash", "Read"]);
      expect(doc.messageIndex).toBe(5);
      expect(doc.tokenCount).toBe(10);
    });
  });

  describe("getAllDocuments", () => {
    it("should return all documents as array", () => {
      store.addDocument("a", 1, makeMetadata());
      store.addDocument("b", 1, makeMetadata());
      store.addDocument("c", 1, makeMetadata());

      const all = store.getAllDocuments();
      expect(all.length).toBe(3);
    });
  });
});
