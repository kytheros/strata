/**
 * Integration test: Full search pipeline on Postgres.
 *
 * Seeds a Postgres database with the same data as the FTS equivalence spike,
 * runs searches through each store, and verifies ranked results.
 * Confirms the full pipeline works end-to-end on Postgres.
 *
 * Requires Docker Postgres running on localhost:5432.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { createSchema } from "../../src/storage/pg/schema.js";
import { PgDocumentStore } from "../../src/storage/pg/pg-document-store.js";
import { PgKnowledgeStore } from "../../src/storage/pg/pg-knowledge-store.js";
import { PgEventStore } from "../../src/storage/pg/pg-event-store.js";
import { PgMetaStore } from "../../src/storage/pg/pg-meta-store.js";
import type { DocumentMetadata } from "../../src/indexing/document-store.js";
import type { KnowledgeEntry } from "../../src/knowledge/knowledge-store.js";
import type { SVOEvent } from "../../src/storage/interfaces/index.js";

const PG_URL = process.env.PG_URL || "postgresql://postgres:test@localhost:5432/postgres";

describe("Postgres Search Integration", () => {
  let pool: pg.Pool | undefined;
  let docStore: PgDocumentStore;
  let knowledgeStore: PgKnowledgeStore;
  let eventStore: PgEventStore;
  let metaStore: PgMetaStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL, max: 5 });
    try {
      await pool.query("SELECT 1");
    } catch {
      console.log("Postgres not available -- skipping integration tests");
      await pool.end();
      pool = undefined;
      return;
    }

    await createSchema(pool);
    // Clean up any leftover data from previous runs (scoped by user)
    await pool.query("DELETE FROM events WHERE user_scope = 'pg-integ-test'");
    await pool.query("DELETE FROM knowledge_history WHERE entry_id IN (SELECT id FROM knowledge WHERE user_scope = 'pg-integ-test')").catch(() => {});
    await pool.query("DELETE FROM knowledge_entities WHERE entry_id IN (SELECT id FROM knowledge WHERE user_scope = 'pg-integ-test')").catch(() => {});
    await pool.query("DELETE FROM knowledge WHERE user_scope = 'pg-integ-test'");
    await pool.query("DELETE FROM documents WHERE user_scope = 'pg-integ-test'");

    docStore = new PgDocumentStore(pool, "pg-integ-test");
    knowledgeStore = new PgKnowledgeStore(pool, "pg-integ-test");
    eventStore = new PgEventStore(pool, "pg-integ-test");
    metaStore = new PgMetaStore(pool);

    // Seed documents (same data as FTS equivalence spike)
    const now = Date.now();
    const docs: Array<{ text: string; project: string; sessionId: string }> = [
      { text: "We decided to use PostgreSQL for the database because it has better JSONB support and robust indexing capabilities", project: "backend", sessionId: "s1" },
      { text: "Fixed the database connection timeout by increasing the pool size to 20 and adding a retry mechanism", project: "backend", sessionId: "s2" },
      { text: "Migrated the React components from class-based to functional hooks for better performance and readability", project: "frontend", sessionId: "s3" },
      { text: "Implemented JWT authentication with refresh tokens and automatic token rotation every 24 hours", project: "backend", sessionId: "s7" },
      { text: "Built the full-text search engine using BM25 ranking algorithm with Porter stemming and unicode tokenization", project: "search", sessionId: "s9" },
    ];

    for (let i = 0; i < docs.length; i++) {
      const d = docs[i];
      const metadata: DocumentMetadata = {
        sessionId: d.sessionId,
        project: d.project,
        role: "user",
        timestamp: now - (docs.length - i) * 60000,
        toolNames: [],
        messageIndex: i,
      };
      await docStore.add(d.text, d.text.split(" ").length, metadata, "claude-code", "pg-integ-test");
    }

    // Seed knowledge entries
    const entries: Array<Partial<KnowledgeEntry>> = [
      { id: "k1", type: "decision", summary: "Use PostgreSQL for database", details: "Better JSONB support and indexing", project: "backend", sessionId: "s1", tags: ["postgres", "database"] },
      { id: "k2", type: "error_fix", summary: "Database connection timeout fix", details: "Increased pool size to 20 with retry mechanism", project: "backend", sessionId: "s2", tags: ["connection", "timeout"] },
      { id: "k3", type: "solution", summary: "React hooks migration complete", details: "Migrated from class-based to functional components", project: "frontend", sessionId: "s3", tags: ["react", "hooks"] },
      { id: "k4", type: "decision", summary: "JWT authentication with refresh tokens", details: "24-hour automatic token rotation", project: "backend", sessionId: "s7", tags: ["auth", "jwt"] },
      { id: "k5", type: "solution", summary: "BM25 search engine implementation", details: "Full-text search with Porter stemming", project: "search", sessionId: "s9", tags: ["search", "bm25"] },
    ];

    for (const e of entries) {
      await knowledgeStore.addEntry({
        id: e.id!,
        type: e.type as KnowledgeEntry["type"],
        summary: e.summary!,
        details: e.details!,
        project: e.project!,
        sessionId: e.sessionId!,
        timestamp: now,
        tags: e.tags!,
        relatedFiles: [],
        user: "pg-integ-test",
      });
    }

    // Seed events
    const events: SVOEvent[] = [
      { subject: "team", verb: "decided", object: "use PostgreSQL", aliases: ["chose postgres database"], category: "technical", sessionId: "s1", project: "backend", timestamp: now, startDate: null, endDate: null },
      { subject: "developer", verb: "fixed", object: "connection timeout", aliases: ["resolved pool exhaustion"], category: "technical", sessionId: "s2", project: "backend", timestamp: now, startDate: null, endDate: null },
      { subject: "team", verb: "migrated", object: "React hooks", aliases: ["converted class components to functional"], category: "technical", sessionId: "s3", project: "frontend", timestamp: now, startDate: null, endDate: null },
    ];
    await eventStore.addEvents(events);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query("DELETE FROM events WHERE user_scope = 'pg-integ-test'").catch(() => {});
      await pool.query("DELETE FROM knowledge_history WHERE entry_id IN (SELECT id FROM knowledge WHERE user_scope = 'pg-integ-test')").catch(() => {});
      await pool.query("DELETE FROM knowledge_entities WHERE entry_id IN (SELECT id FROM knowledge WHERE user_scope = 'pg-integ-test')").catch(() => {});
      await pool.query("DELETE FROM knowledge WHERE user_scope = 'pg-integ-test'").catch(() => {});
      await pool.query("DELETE FROM documents WHERE user_scope IN ('pg-integ-test', 'integ-user-a', 'integ-user-b')").catch(() => {});
      await pool.end();
    }
  });

  // Document search
  it("should find PostgreSQL documents via tsvector search", async () => {
    if (!pool) return;
    const results = await docStore.search("PostgreSQL database");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].chunk.text).toContain("PostgreSQL");
    expect(results[0].rank).toBeGreaterThan(0);
  });

  it("should rank direct keyword matches higher", async () => {
    if (!pool) return;
    const results = await docStore.search("JWT authentication refresh tokens");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].chunk.text).toContain("JWT");
  });

  it("should return positive scores (not negative like FTS5)", async () => {
    if (!pool) return;
    const results = await docStore.search("search ranking");
    for (const r of results) {
      expect(r.rank).toBeGreaterThan(0);
    }
  });

  // Knowledge search (weighted: summary=A, details=B, tags=C)
  it("should search knowledge with weighted ranking", async () => {
    if (!pool) return;
    const results = await knowledgeStore.search("PostgreSQL database");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].summary).toContain("PostgreSQL");
  });

  it("should filter knowledge search by project", async () => {
    if (!pool) return;
    const results = await knowledgeStore.search("migration", "frontend");
    expect(results.every((r) => r.project.toLowerCase().includes("frontend"))).toBe(true);
  });

  // Event search (weighted: subject=A, verb=B, object=C, aliases=D)
  it("should search events with weighted ranking", async () => {
    if (!pool) return;
    const results = await eventStore.search("PostgreSQL");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("should find events via aliases", async () => {
    if (!pool) return;
    const results = await eventStore.search("pool exhaustion");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].verb).toBe("fixed");
  });

  // Meta store
  it("should persist and retrieve metadata across queries", async () => {
    if (!pool) return;
    await metaStore.set("last_indexed", "2026-03-31");
    const value = await metaStore.get("last_indexed");
    expect(value).toBe("2026-03-31");
  });

  // Multi-tenant isolation
  it("should isolate searches by user scope", async () => {
    if (!pool) return;
    const userADocs = new PgDocumentStore(pool!, "integ-user-a");
    const userBDocs = new PgDocumentStore(pool!, "integ-user-b");

    await userADocs.add("user A private note about Redis caching", 6, {
      sessionId: "integ-sa1",
      project: "private-a",
      role: "user",
      timestamp: Date.now(),
      toolNames: [],
      messageIndex: 0,
    }, "claude-code", "integ-user-a");

    await userBDocs.add("user B private note about Redis caching", 6, {
      sessionId: "integ-sb1",
      project: "private-b",
      role: "user",
      timestamp: Date.now(),
      toolNames: [],
      messageIndex: 0,
    }, "claude-code", "integ-user-b");

    const resultsA = await userADocs.search("Redis caching");
    const resultsB = await userBDocs.search("Redis caching");

    // Each user should only see their own documents
    expect(resultsA.length).toBe(1);
    expect(resultsA[0].chunk.text).toContain("user A");
    expect(resultsB.length).toBe(1);
    expect(resultsB[0].chunk.text).toContain("user B");
  });

  // Cross-store search (simulates how the search engine combines results)
  it("should support cross-store retrieval for same query", async () => {
    if (!pool) return;
    const query = "PostgreSQL";

    const docResults = await docStore.search(query);
    const knowledgeResults = await knowledgeStore.search(query);
    const eventResults = await eventStore.search(query);

    // All three stores should find PostgreSQL-related content
    expect(docResults.length).toBeGreaterThanOrEqual(1);
    expect(knowledgeResults.length).toBeGreaterThanOrEqual(1);
    expect(eventResults.length).toBeGreaterThanOrEqual(1);
  });
});
