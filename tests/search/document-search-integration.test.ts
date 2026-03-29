import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import { DocumentChunkStore, type StoredDocument, type DocumentChunk as StoredDocumentChunk } from "../../src/storage/document-chunk-store.js";
import type { DocumentMetadata } from "../../src/indexing/document-store.js";

function makeMetadata(overrides: Partial<DocumentMetadata> = {}): DocumentMetadata {
  return {
    sessionId: "session-1",
    project: "test-project",
    role: "mixed",
    timestamp: Date.now(),
    toolNames: [],
    messageIndex: 0,
    ...overrides,
  };
}

describe("SqliteSearchEngine document integration", () => {
  it("has a setDocumentChunkStore method", () => {
    const db = openDatabase(":memory:");
    const store = new SqliteDocumentStore(db);
    const engine = new SqliteSearchEngine(store);
    expect(typeof engine.setDocumentChunkStore).toBe("function");
    db.close();
  });
});

describe("searchAsync with stored documents", () => {
  let db: Database.Database;
  let engine: SqliteSearchEngine;
  let docChunkStore: DocumentChunkStore;
  let convDocStore: SqliteDocumentStore;

  beforeAll(async () => {
    db = openDatabase(":memory:");
    convDocStore = new SqliteDocumentStore(db);
    engine = new SqliteSearchEngine(convDocStore);

    docChunkStore = new DocumentChunkStore(db);
    engine.setDocumentChunkStore(docChunkStore);

    // Insert a stored document with searchable text
    docChunkStore.addDocument(
      {
        id: "doc-react",
        title: "React Architecture Guide",
        mimeType: "text/plain",
        project: "frontend",
        user: "default",
        tags: ["react"],
        chunkCount: 1,
        fileSize: 3000,
        createdAt: Date.now(),
      },
      [
        {
          id: "chunk-react-1",
          documentId: "doc-react",
          chunkIndex: 0,
          content: "React server components render on the server and stream HTML to the client",
          embedding: new Float32Array(3072),
          model: "gemini-embedding-001",
          createdAt: Date.now(),
        },
      ]
    );

    // Insert a conversation chunk about a different topic
    await convDocStore.add(
      "We discussed deploying the nginx reverse proxy configuration",
      12,
      makeMetadata({ sessionId: "session-1", project: "frontend", timestamp: Date.now() }),
    );
  });

  afterAll(() => db.close());

  it("finds stored documents via FTS5 keyword search", async () => {
    const results = await engine.searchAsync("React server components");
    expect(results.length).toBeGreaterThan(0);

    const docResult = results.find((r) => r.source === "document");
    expect(docResult).toBeDefined();
    expect(docResult!.text).toContain("server components");
    expect(docResult!.source).toBe("document");
  });

  it("finds conversation chunks with source: conversation", async () => {
    const results = await engine.searchAsync("nginx reverse proxy");
    expect(results.length).toBeGreaterThan(0);

    const convResult = results.find((r) => r.source === "conversation");
    expect(convResult).toBeDefined();
    expect(convResult!.source).toBe("conversation");
  });

  it("merges document and conversation results in the same query", async () => {
    // Insert another doc chunk that matches "deployment" / "deploying"
    docChunkStore.addDocument(
      {
        id: "doc-deploy",
        title: "Deployment Guide",
        mimeType: "text/plain",
        project: "frontend",
        user: "default",
        tags: [],
        chunkCount: 1,
        fileSize: 1000,
        createdAt: Date.now(),
      },
      [
        {
          id: "chunk-deploy-1",
          documentId: "doc-deploy",
          chunkIndex: 0,
          content: "Deploying the frontend application to production servers",
          embedding: new Float32Array(3072),
          model: "gemini-embedding-001",
          createdAt: Date.now(),
        },
      ]
    );

    const results = await engine.searchAsync("deploying frontend");
    const sources = results.map((r) => r.source);
    // Should have both types (conversation has "deploying nginx", doc has "deploying frontend")
    expect(sources).toContain("document");
    expect(sources).toContain("conversation");
  });
});

describe("search (sync FTS5-only) with stored documents", () => {
  let db: Database.Database;
  let engine: SqliteSearchEngine;
  let docChunkStore: DocumentChunkStore;

  beforeAll(async () => {
    db = openDatabase(":memory:");
    const convDocStore = new SqliteDocumentStore(db);
    engine = new SqliteSearchEngine(convDocStore);

    docChunkStore = new DocumentChunkStore(db);
    engine.setDocumentChunkStore(docChunkStore);

    docChunkStore.addDocument(
      {
        id: "doc-sync-1",
        title: "PostgreSQL Performance Guide",
        mimeType: "text/plain",
        project: "backend",
        user: "default",
        tags: ["postgres"],
        chunkCount: 1,
        fileSize: 2000,
        createdAt: Date.now(),
      },
      [
        {
          id: "chunk-sync-1",
          documentId: "doc-sync-1",
          chunkIndex: 0,
          content: "PostgreSQL query optimization with indexes and explain analyze plans",
          embedding: new Float32Array(3072),
          model: "gemini-embedding-001",
          createdAt: Date.now(),
        },
      ]
    );
  });

  afterAll(() => db.close());

  it("finds stored documents via FTS5-only search", async () => {
    const results = await engine.search("PostgreSQL indexes optimization");
    expect(results.length).toBeGreaterThan(0);

    const docResult = results.find((r) => r.source === "document");
    expect(docResult).toBeDefined();
    expect(docResult!.source).toBe("document");
    expect(docResult!.text).toContain("PostgreSQL");
  });

  it("tags conversation results with source: conversation", async () => {
    // Add a conversation chunk
    const convDocStore = new SqliteDocumentStore(db);
    await convDocStore.add(
      "We discussed database migration strategies for PostgreSQL",
      10,
      makeMetadata({ sessionId: "session-db", project: "backend" }),
    );

    const results = await engine.search("PostgreSQL migration");
    expect(results.length).toBeGreaterThan(0);

    const convResult = results.find((r) => r.source === "conversation");
    expect(convResult).toBeDefined();
    expect(convResult!.source).toBe("conversation");
  });
});

describe("searchSessionLevel with stored documents", () => {
  let db: Database.Database;
  let engine: SqliteSearchEngine;
  let docChunkStore: DocumentChunkStore;

  beforeAll(async () => {
    db = openDatabase(":memory:");
    const convDocStore = new SqliteDocumentStore(db);
    engine = new SqliteSearchEngine(convDocStore);

    docChunkStore = new DocumentChunkStore(db);
    engine.setDocumentChunkStore(docChunkStore);

    docChunkStore.addDocument(
      {
        id: "doc-session-1",
        title: "Kubernetes Deployment Guide",
        mimeType: "text/plain",
        project: "infra",
        user: "default",
        tags: ["kubernetes"],
        chunkCount: 2,
        fileSize: 5000,
        createdAt: Date.now(),
      },
      [
        {
          id: "chunk-session-1a",
          documentId: "doc-session-1",
          chunkIndex: 0,
          content: "Kubernetes pod scheduling uses resource requests and limits for node placement",
          embedding: new Float32Array(3072),
          model: "gemini-embedding-001",
          createdAt: Date.now(),
        },
        {
          id: "chunk-session-1b",
          documentId: "doc-session-1",
          chunkIndex: 1,
          content: "Kubernetes horizontal pod autoscaler adjusts replicas based on CPU utilization metrics",
          embedding: new Float32Array(3072),
          model: "gemini-embedding-001",
          createdAt: Date.now(),
        },
      ]
    );

    // Add a conversation for comparison
    await convDocStore.add(
      "We configured Kubernetes cluster autoscaler for the production namespace",
      12,
      makeMetadata({ sessionId: "session-k8s", project: "infra" }),
    );
  });

  afterAll(() => db.close());

  it("includes document results in session-level search", async () => {
    const results = await engine.searchSessionLevel("Kubernetes pod scheduling", { limit: 10 });
    const docResult = results.find((r) => r.source === "document");
    expect(docResult).toBeDefined();
    expect(docResult!.source).toBe("document");
  });

  it("aggregates multi-chunk documents into one session result", async () => {
    const results = await engine.searchSessionLevel("Kubernetes", { limit: 10 });
    // Both chunks from doc-session-1 should aggregate to one result with sessionId = documentId
    const docResults = results.filter((r) => r.source === "document");
    const docSessionIds = new Set(docResults.map((r) => r.sessionId));
    // The document should appear as a single session (documentId = "doc-session-1")
    expect(docSessionIds.has("doc-session-1")).toBe(true);
    // Should not have duplicate entries for the same document
    expect(docResults.filter((r) => r.sessionId === "doc-session-1").length).toBe(1);
  });

  it("includes both document and conversation results", async () => {
    const results = await engine.searchSessionLevel("Kubernetes autoscaler", { limit: 10 });
    const sources = results.map((r) => r.source);
    expect(sources).toContain("document");
    expect(sources).toContain("conversation");
  });
});
