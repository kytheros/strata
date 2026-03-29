import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { DocumentChunkStore, type StoredDocument, type DocumentChunk } from "../../src/storage/document-chunk-store.js";

describe("DocumentChunkStore", () => {
  let db: Database.Database;
  let store: DocumentChunkStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new DocumentChunkStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("stores a document with chunks", () => {
    const doc: StoredDocument = {
      id: "doc-1",
      title: "Test Report",
      mimeType: "application/pdf",
      project: "test-project",
      tags: ["quarterly", "finance"],
      chunkCount: 2,
      totalPages: 10,
      fileSize: 1024,
      createdAt: Date.now(),
    };

    const chunks: DocumentChunk[] = [
      {
        id: "chunk-1",
        documentId: "doc-1",
        chunkIndex: 0,
        content: "Page 1 through 6 content here",
        embedding: new Float32Array(3072).fill(0.1),
        model: "gemini-embedding-2-preview",
        pageStart: 1,
        pageEnd: 6,
        createdAt: Date.now(),
      },
      {
        id: "chunk-2",
        documentId: "doc-1",
        chunkIndex: 1,
        content: "Page 7 through 10 content here",
        embedding: new Float32Array(3072).fill(0.2),
        model: "gemini-embedding-2-preview",
        pageStart: 7,
        pageEnd: 10,
        createdAt: Date.now(),
      },
    ];

    store.addDocument(doc, chunks);

    const retrieved = store.getDocument("doc-1");
    expect(retrieved).toBeDefined();
    expect(retrieved!.title).toBe("Test Report");
    expect(retrieved!.chunkCount).toBe(2);
  });

  it("retrieves chunks for a document", () => {
    const doc: StoredDocument = {
      id: "doc-2",
      title: "Simple Doc",
      mimeType: "text/plain",
      project: "global",
      tags: [],
      chunkCount: 1,
      fileSize: 100,
      createdAt: Date.now(),
    };

    const chunks: DocumentChunk[] = [{
      id: "chunk-3",
      documentId: "doc-2",
      chunkIndex: 0,
      content: "Some plain text content",
      embedding: new Float32Array(3072).fill(0.5),
      model: "gemini-embedding-2-preview",
      tokenCount: 50,
      createdAt: Date.now(),
    }];

    store.addDocument(doc, chunks);
    const result = store.getChunks("doc-2");
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Some plain text content");
  });

  it("returns all chunk embeddings for vector search", () => {
    const doc: StoredDocument = {
      id: "doc-3",
      title: "Vector Doc",
      mimeType: "text/plain",
      project: "global",
      tags: [],
      chunkCount: 1,
      fileSize: 50,
      createdAt: Date.now(),
    };

    const chunks: DocumentChunk[] = [{
      id: "chunk-4",
      documentId: "doc-3",
      chunkIndex: 0,
      content: "searchable text",
      embedding: new Float32Array(3072).fill(0.3),
      model: "gemini-embedding-2-preview",
      createdAt: Date.now(),
    }];

    store.addDocument(doc, chunks);

    const embeddings = store.getAllEmbeddings();
    expect(embeddings.length).toBeGreaterThanOrEqual(1);
    expect(embeddings[0].chunkId).toBe("chunk-4");
    expect(embeddings[0].embedding).toBeInstanceOf(Buffer);
  });

  it("returns embeddings filtered by project", () => {
    const doc1: StoredDocument = {
      id: "doc-a",
      title: "Project A Doc",
      mimeType: "text/plain",
      project: "project-a",
      tags: [],
      chunkCount: 1,
      fileSize: 50,
      createdAt: Date.now(),
    };

    const doc2: StoredDocument = {
      id: "doc-b",
      title: "Project B Doc",
      mimeType: "text/plain",
      project: "project-b",
      tags: [],
      chunkCount: 1,
      fileSize: 50,
      createdAt: Date.now(),
    };

    store.addDocument(doc1, [{
      id: "chunk-a",
      documentId: "doc-a",
      chunkIndex: 0,
      content: "project a content",
      embedding: new Float32Array(3072).fill(0.1),
      model: "gemini-embedding-2-preview",
      createdAt: Date.now(),
    }]);

    store.addDocument(doc2, [{
      id: "chunk-b",
      documentId: "doc-b",
      chunkIndex: 0,
      content: "project b content",
      embedding: new Float32Array(3072).fill(0.2),
      model: "gemini-embedding-2-preview",
      createdAt: Date.now(),
    }]);

    const results = store.getEmbeddingsByProject("project-a");
    expect(results).toHaveLength(1);
    expect(results[0].chunkId).toBe("chunk-a");
  });

  it("deletes a document and its chunks", () => {
    const doc: StoredDocument = {
      id: "doc-del",
      title: "To Delete",
      mimeType: "text/plain",
      project: "global",
      tags: [],
      chunkCount: 1,
      fileSize: 50,
      createdAt: Date.now(),
    };

    store.addDocument(doc, [{
      id: "chunk-del",
      documentId: "doc-del",
      chunkIndex: 0,
      content: "delete me",
      embedding: new Float32Array(3072).fill(0),
      model: "gemini-embedding-2-preview",
      createdAt: Date.now(),
    }]);

    store.deleteDocument("doc-del");
    expect(store.getDocument("doc-del")).toBeUndefined();
    expect(store.getChunks("doc-del")).toHaveLength(0);
  });
});
