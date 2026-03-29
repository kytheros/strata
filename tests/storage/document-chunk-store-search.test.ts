import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { DocumentChunkStore, type StoredDocument, type DocumentChunk } from "../../src/storage/document-chunk-store.js";

describe("DocumentChunkStore.searchFts", () => {
  let db: Database.Database;
  let store: DocumentChunkStore;

  beforeAll(() => {
    db = openDatabase(":memory:");
    store = new DocumentChunkStore(db);

    // Insert a test document with 2 chunks
    store.addDocument(
      {
        id: "doc-1",
        title: "React Testing Guide",
        mimeType: "text/plain",
        project: "my-app",
        user: "default",
        tags: ["react", "testing"],
        chunkCount: 2,
        fileSize: 5000,
        createdAt: Date.now(),
      },
      [
        {
          id: "chunk-1",
          documentId: "doc-1",
          chunkIndex: 0,
          content: "React component testing with vitest and React Testing Library",
          embedding: new Float32Array(3072),
          model: "gemini-embedding-001",
          createdAt: Date.now(),
        },
        {
          id: "chunk-2",
          documentId: "doc-1",
          chunkIndex: 1,
          content: "Snapshot testing and integration test patterns for React hooks",
          embedding: new Float32Array(3072),
          model: "gemini-embedding-001",
          createdAt: Date.now(),
        },
      ]
    );
  });

  afterAll(() => db.close());

  it("finds chunks matching a keyword query", () => {
    const results = store.searchFts("vitest React", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunkId).toBe("chunk-1");
    expect(results[0].documentId).toBe("doc-1");
    expect(results[0].project).toBe("my-app");
    expect(results[0].content).toContain("vitest");
    expect(typeof results[0].rank).toBe("number");
  });

  it("returns empty array for no matches", () => {
    const results = store.searchFts("kubernetes deployment", 10);
    expect(results).toEqual([]);
  });

  it("respects the limit parameter", () => {
    const results = store.searchFts("React testing", 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("returns results with title from parent document", () => {
    const results = store.searchFts("hooks", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe("React Testing Guide");
  });

  it("handles queries with FTS5 special characters", () => {
    const results = store.searchFts('React "component" (testing)', 10);
    expect(results.length).toBeGreaterThan(0);
  });

  it("returns empty array for empty query after sanitization", () => {
    const results = store.searchFts("   ", 10);
    expect(results).toEqual([]);
  });
});

describe("DocumentChunkStore.getChunkWithMeta", () => {
  let db: Database.Database;
  let store: DocumentChunkStore;

  beforeAll(() => {
    db = openDatabase(":memory:");
    store = new DocumentChunkStore(db);

    store.addDocument(
      {
        id: "doc-meta-1",
        title: "Architecture Overview",
        mimeType: "application/pdf",
        project: "platform",
        user: "default",
        tags: ["architecture"],
        chunkCount: 1,
        fileSize: 3000,
        createdAt: 1700000000000,
      },
      [
        {
          id: "chunk-meta-1",
          documentId: "doc-meta-1",
          chunkIndex: 0,
          content: "Microservices with gRPC communication",
          embedding: new Float32Array(3072),
          model: "gemini-embedding-001",
          createdAt: 1700000000000,
        },
      ]
    );
  });

  afterAll(() => db.close());

  it("returns chunk with parent document metadata", () => {
    const result = store.getChunkWithMeta("chunk-meta-1");
    expect(result).toBeDefined();
    expect(result!.chunkId).toBe("chunk-meta-1");
    expect(result!.documentId).toBe("doc-meta-1");
    expect(result!.project).toBe("platform");
    expect(result!.title).toBe("Architecture Overview");
    expect(result!.content).toBe("Microservices with gRPC communication");
    expect(result!.createdAt).toBe(1700000000000);
  });

  it("returns undefined for non-existent chunk", () => {
    const result = store.getChunkWithMeta("non-existent");
    expect(result).toBeUndefined();
  });
});
