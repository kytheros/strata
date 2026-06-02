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

  it("handles queries with question marks without crashing", () => {
    // Bug: ? is an FTS5 special character that was not being sanitized
    const results = store.searchFts("What is React?", 10);
    expect(results.length).toBeGreaterThan(0);
  });

  it("handles queries with apostrophes without crashing", () => {
    // Bug: ' breaks FTS5 string literals and was not being sanitized
    const results = store.searchFts("React's testing", 10);
    expect(results.length).toBeGreaterThan(0);
  });

  it("handles queries with mixed special characters", () => {
    // Regression: ensure combinations of special chars are all stripped without crashing.
    // After sanitization + stop-word removal, this becomes "React testing hooks component"
    // which uses implicit AND — no single chunk contains ALL four terms, so zero results
    // is correct. The key assertion is that it does not throw.
    expect(() => store.searchFts("What's the React testing? [hooks] @component!", 10)).not.toThrow();
  });
});

// BLOCKER 1 regression: searchDocumentChunks must scope to the DOCUMENT model
// ('gemini-embedding-2-preview'), not the text embedding model ('gemini-embedding-001').
// Before the fix, the doc-chunk SQL had `AND dc.model = this.activeModel` (text model),
// so it always returned [] for document chunks stored under the doc model.
describe("VectorSearch.searchDocumentChunks — document model scoping", () => {
  let db: Database.Database;

  beforeAll(() => {
    db = openDatabase(":memory:");
    // Insert a stored_document and one chunk with model='gemini-embedding-2-preview'
    db.prepare(`INSERT INTO stored_documents (id, title, mime_type, project, user, chunk_count, file_size, created_at)
                VALUES ('sd1', 'guide.pdf', 'application/pdf', 'proj', 'default', 1, 1000, 0)`).run();
    // 3072-dim float32 blob (matches the document embedder dimension)
    const v = new Float32Array(3072); v[0] = 1;
    const blob = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    // `format` column added via migration — openDatabase runs migrations so it exists
    db.prepare(`INSERT INTO document_chunks (id, document_id, content, chunk_index, embedding, model, created_at, format)
                VALUES ('dc1', 'sd1', 'hello', 0, ?, 'gemini-embedding-2-preview', 0, 'float32')`).run(blob);
  });

  afterAll(() => db.close());

  it("returns doc-chunk results when model='gemini-embedding-2-preview'", async () => {
    const { VectorSearch } = await import("../../src/extensions/embeddings/vector-search.js");
    const vs = new VectorSearch(db); // activeModel defaults to gemini-embedding-001 (text model)
    const q = new Float32Array(3072); q[0] = 1;
    const hits = vs.searchDocumentChunks(q, 10);
    // Before fix: [] because dc.model='gemini-embedding-2-preview' != activeModel='gemini-embedding-001'
    // After fix: ['dc1'] because searchDocumentChunks uses CONFIG.embeddings.documentModel
    expect(hits.map((h: any) => h.entryId)).toContain("dc1");
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
