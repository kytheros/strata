/**
 * End-to-end integration test: store_document → search round-trip.
 *
 * Verifies that documents stored via DocumentChunkStore are findable
 * through all search methods (search, searchAsync, searchSessionLevel).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { DocumentChunkStore } from "../../src/storage/document-chunk-store.js";
import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import type { DocumentMetadata } from "../../src/indexing/document-store.js";

describe("store_document → search round-trip", () => {
  let db: Database.Database;
  let engine: SqliteSearchEngine;
  let docChunkStore: DocumentChunkStore;

  beforeAll(async () => {
    db = openDatabase(":memory:");

    const convStore = new SqliteDocumentStore(db);
    engine = new SqliteSearchEngine(convStore);

    docChunkStore = new DocumentChunkStore(db);
    engine.setDocumentChunkStore(docChunkStore);

    // Simulate what store_document does: insert a document with chunks
    docChunkStore.addDocument(
      {
        id: "doc-arch",
        title: "System Architecture Doc",
        mimeType: "application/pdf",
        project: "platform",
        user: "default",
        tags: ["architecture", "microservices"],
        chunkCount: 2,
        totalPages: 10,
        fileSize: 50000,
        createdAt: Date.now(),
      },
      [
        {
          id: "arch-chunk-1",
          documentId: "doc-arch",
          chunkIndex: 0,
          content: "The system uses a microservices architecture with gRPC for inter-service communication and PostgreSQL for persistence",
          embedding: new Float32Array(3072),
          model: "gemini-embedding-001",
          createdAt: Date.now(),
        },
        {
          id: "arch-chunk-2",
          documentId: "doc-arch",
          chunkIndex: 1,
          content: "Authentication uses OAuth 2.0 with PKCE flow and JWT tokens stored in HttpOnly cookies",
          embedding: new Float32Array(3072),
          model: "gemini-embedding-001",
          createdAt: Date.now(),
        },
      ]
    );

    // Also add a conversation for mixed-source testing
    await convStore.add(
      "We discussed the database schema migration for the authentication service",
      12,
      {
        sessionId: "session-auth",
        project: "platform",
        role: "assistant" as const,
        timestamp: Date.now(),
        toolNames: [],
        messageIndex: 0,
      },
    );
  });

  afterAll(() => db.close());

  it("searchAsync finds stored document via keyword", async () => {
    const results = await engine.searchAsync("microservices gRPC");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe("document");
    expect(results[0].text).toContain("microservices");
  });

  it("searchAsync finds different chunks from same document", async () => {
    const results = await engine.searchAsync("OAuth PKCE JWT");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe("document");
    expect(results[0].text).toContain("OAuth");
  });

  it("results include project from parent document", async () => {
    const results = await engine.searchAsync("microservices");
    const docResult = results.find((r) => r.source === "document");
    expect(docResult?.project).toBe("platform");
  });

  it("FTS5-only search (no embedder) still finds documents", async () => {
    // engine has no embedder configured, so this is pure FTS5
    const results = await engine.search("PostgreSQL persistence");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe("document");
  });

  it("session-level search finds stored documents", async () => {
    const results = await engine.searchSessionLevel("microservices architecture", { limit: 10 });
    const docResult = results.find((r) => r.source === "document");
    expect(docResult).toBeDefined();
    expect(docResult!.sessionId).toBe("doc-arch");
  });

  it("mixes document and conversation results", async () => {
    const results = await engine.searchAsync("authentication");
    const sources = new Set(results.map((r) => r.source));
    expect(sources.has("document")).toBe(true);
    expect(sources.has("conversation")).toBe(true);
  });

  it("document results use documentId as sessionId", async () => {
    const results = await engine.searchAsync("gRPC inter-service");
    const docResult = results.find((r) => r.source === "document");
    expect(docResult).toBeDefined();
    // The sessionId should be the document ID, not a conversation session
    expect(docResult!.sessionId).toBe("doc-arch");
  });

  it("conversation results retain source: conversation", async () => {
    const results = await engine.searchAsync("database schema migration");
    const convResult = results.find((r) => r.source === "conversation");
    expect(convResult).toBeDefined();
    expect(convResult!.source).toBe("conversation");
    expect(convResult!.sessionId).toBe("session-auth");
  });
});
