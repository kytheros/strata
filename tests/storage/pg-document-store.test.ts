/**
 * Test: PgDocumentStore — CRUD + FTS search ranking.
 *
 * Requires Docker Postgres running on localhost:5432.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { createSchema, dropSchema } from "../../src/storage/pg/schema.js";
import { PgDocumentStore } from "../../src/storage/pg/pg-document-store.js";
import type { DocumentMetadata } from "../../src/indexing/document-store.js";

const PG_URL = process.env.PG_URL || "postgresql://postgres:test@localhost:5432/postgres";

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

describe("PgDocumentStore", () => {
  let pool: pg.Pool | undefined;
  let store: PgDocumentStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL, max: 5 });
    try {
      await pool.query("SELECT 1");
    } catch {
      console.log("Postgres not available -- skipping PgDocumentStore tests");
      await pool.end();
      pool = undefined;
    }
  });

  beforeEach(async () => {
    if (!pool) return;
    await dropSchema(pool);
    await createSchema(pool);
    store = new PgDocumentStore(pool, "pg-doc-test");
  });

  afterAll(async () => {
    if (pool) {
      await dropSchema(pool).catch(() => {});
      await pool.end();
    }
  });

  it("should add and retrieve a document by ID", async () => {
    if (!pool) return;
    const id = await store.add("hello world", 2, makeMetadata());
    const doc = await store.get(id);

    expect(doc).toBeDefined();
    expect(doc!.id).toBe(id);
    expect(doc!.text).toBe("hello world");
    expect(doc!.tokenCount).toBe(2);
    expect(doc!.sessionId).toBe("session-1");
    expect(doc!.project).toBe("test-project");
  });

  it("should return undefined for non-existent ID", async () => {
    if (!pool) return;
    expect(await store.get("non-existent")).toBeUndefined();
  });

  it("should get documents by session", async () => {
    if (!pool) return;
    await store.add("msg 1", 2, makeMetadata({ messageIndex: 0 }));
    await store.add("msg 2", 2, makeMetadata({ messageIndex: 1 }));
    await store.add("other session", 2, makeMetadata({ sessionId: "session-2", messageIndex: 0 }));

    const docs = await store.getBySession("session-1");
    expect(docs.length).toBe(2);
    expect(docs[0].messageIndex).toBe(0);
    expect(docs[1].messageIndex).toBe(1);
  });

  it("should remove a document", async () => {
    if (!pool) return;
    const id = await store.add("to delete", 2, makeMetadata());
    await store.remove(id);
    expect(await store.get(id)).toBeUndefined();
  });

  it("should remove all documents in a session", async () => {
    if (!pool) return;
    await store.add("msg 1", 2, makeMetadata({ messageIndex: 0 }));
    await store.add("msg 2", 2, makeMetadata({ messageIndex: 1 }));
    await store.removeSession("session-1");
    expect((await store.getBySession("session-1")).length).toBe(0);
  });

  it("should return document count", async () => {
    if (!pool) return;
    await store.add("one", 1, makeMetadata());
    await store.add("two", 1, makeMetadata());
    expect(await store.getDocumentCount()).toBe(2);
  });

  it("should get distinct session IDs", async () => {
    if (!pool) return;
    await store.add("a", 1, makeMetadata({ sessionId: "s1" }));
    await store.add("b", 1, makeMetadata({ sessionId: "s2" }));
    await store.add("c", 1, makeMetadata({ sessionId: "s1" }));

    const ids = await store.getSessionIds();
    expect(ids.size).toBe(2);
    expect(ids.has("s1")).toBe(true);
    expect(ids.has("s2")).toBe(true);
  });

  it("should search using tsvector and return ranked results", async () => {
    if (!pool) return;
    await store.add(
      "PostgreSQL database with JSONB support and robust indexing",
      8,
      makeMetadata({ messageIndex: 0 })
    );
    await store.add(
      "React component migration from classes to hooks",
      7,
      makeMetadata({ messageIndex: 1 })
    );
    await store.add(
      "Docker Compose production deployment with nginx reverse proxy",
      8,
      makeMetadata({ messageIndex: 2 })
    );

    const results = await store.search("PostgreSQL database");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].chunk.text).toContain("PostgreSQL");
    expect(results[0].rank).toBeGreaterThan(0); // Postgres returns positive scores
  });

  it("should search by date range", async () => {
    if (!pool) return;
    const now = Date.now();
    await store.add("old doc", 2, makeMetadata({ timestamp: now - 100000 }));
    await store.add("recent doc", 2, makeMetadata({ timestamp: now }));

    const docs = await store.searchByDateRange(now - 50000, now + 1000);
    expect(docs.length).toBe(1);
    expect(docs[0].text).toBe("recent doc");
  });

  it("should isolate documents by user scope", async () => {
    if (!pool) return;
    const userAStore = new PgDocumentStore(pool!, "doc-user-a");
    const userBStore = new PgDocumentStore(pool!, "doc-user-b");

    await userAStore.add("user A data", 3, makeMetadata(), "claude-code", "doc-user-a");
    await userBStore.add("user B data", 3, makeMetadata(), "claude-code", "doc-user-b");

    const aCount = await userAStore.getDocumentCount();
    const bCount = await userBStore.getDocumentCount();
    expect(aCount).toBe(1);
    expect(bCount).toBe(1);
  });
});
