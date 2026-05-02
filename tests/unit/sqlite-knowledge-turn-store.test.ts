/**
 * Unit tests for SqliteKnowledgeTurnStore.
 *
 * Coverage:
 * - insert / retrieve round-trip
 * - FTS5 phrase + token search
 * - multi-tenant user_id filter (X never leaks into Y's results)
 * - project filter
 * - deletion cascade through FTS triggers (insert → delete → FTS row gone)
 * - bulkInsert
 * - count()
 * - getBySessionId / deleteBySessionId
 *
 * Spec: 2026-05-01-tirqdp-community-port-design.md
 * Ticket: TIRQDP-1.2
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteKnowledgeTurnStore } from "../../src/storage/sqlite-knowledge-turn-store.js";
import type { KnowledgeTurnInput } from "../../src/storage/interfaces/knowledge-turn-store.js";

// ── helpers ─────────────────────────────────────────────────────────────────

function makeTurn(overrides: Partial<KnowledgeTurnInput> = {}): KnowledgeTurnInput {
  return {
    sessionId: "sess-1",
    project: "test-project",
    userId: "user-alice",
    speaker: "user",
    content: "The authentication token expires after 24 hours",
    messageIndex: 0,
    ...overrides,
  };
}

let db: Database.Database;
let store: SqliteKnowledgeTurnStore;

beforeEach(() => {
  db = openDatabase(":memory:");
  store = new SqliteKnowledgeTurnStore(db);
});

afterEach(() => {
  db.close();
});

// ── tests ────────────────────────────────────────────────────────────────────

describe("SqliteKnowledgeTurnStore", () => {

  // ── insert / retrieve round-trip ─────────────────────────────────────────

  it("insert() returns a UUID and persists the row", () => {
    const id = store.insert(makeTurn());
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.count()).toBe(1);
  });

  it("insert() stores all fields correctly", () => {
    const input = makeTurn({
      sessionId: "sess-abc",
      project: "proj-x",
      userId: "user-bob",
      speaker: "assistant",
      content: "Use bcrypt with cost factor 12",
      messageIndex: 3,
    });
    const id = store.insert(input);
    const rows = store.getBySessionId("sess-abc");
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.turnId).toBe(id);
    expect(row.sessionId).toBe("sess-abc");
    expect(row.project).toBe("proj-x");
    expect(row.userId).toBe("user-bob");
    expect(row.speaker).toBe("assistant");
    expect(row.content).toBe("Use bcrypt with cost factor 12");
    expect(row.messageIndex).toBe(3);
    expect(typeof row.createdAt).toBe("number");
    expect(row.createdAt).toBeGreaterThan(0);
  });

  // ── bulkInsert ────────────────────────────────────────────────────────────

  it("bulkInsert() inserts all turns atomically", () => {
    const turns = [
      makeTurn({ content: "First message", messageIndex: 0 }),
      makeTurn({ content: "Second message", messageIndex: 1 }),
      makeTurn({ content: "Third message", messageIndex: 2 }),
    ];
    store.bulkInsert(turns);
    expect(store.count()).toBe(3);
  });

  it("bulkInsert() returns inserted turn IDs", () => {
    const turns = [makeTurn({ messageIndex: 0 }), makeTurn({ messageIndex: 1 })];
    const ids = store.bulkInsert(turns);
    expect(ids).toHaveLength(2);
    ids.forEach(id => expect(id).toMatch(/^[0-9a-f-]{36}$/));
  });

  // ── FTS5 search — token search ────────────────────────────────────────────

  it("searchByQuery() finds turns matching a single token", () => {
    store.insert(makeTurn({ content: "The authentication token expires after 24 hours", userId: "user-alice" }));
    store.insert(makeTurn({ content: "Nice weather today", userId: "user-alice" }));
    const hits = store.searchByQuery("authentication", { userId: "user-alice", limit: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0].row.content).toContain("authentication");
  });

  it("searchByQuery() finds turns matching multiple tokens (OR)", () => {
    store.insert(makeTurn({ content: "The authentication token", userId: "user-alice" }));
    store.insert(makeTurn({ content: "Token refresh logic", userId: "user-alice" }));
    store.insert(makeTurn({ content: "Unrelated database config", userId: "user-alice" }));
    const hits = store.searchByQuery("authentication token", { userId: "user-alice", limit: 10 });
    // Both "authentication token" and "Token refresh logic" should match (token appears in both)
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it("searchByQuery() returns { row, score } shape with numeric BM25 score", () => {
    store.insert(makeTurn({ content: "bcrypt password hashing algorithm", userId: "user-alice" }));
    const hits = store.searchByQuery("bcrypt", { userId: "user-alice", limit: 5 });
    expect(hits).toHaveLength(1);
    expect(typeof hits[0].score).toBe("number");
    expect(hits[0].score).toBeGreaterThan(0); // negated BM25: higher = more relevant
    expect(hits[0].row).toBeDefined();
    expect(hits[0].row.turnId).toBeDefined();
  });

  it("searchByQuery() returns empty array for empty query", () => {
    store.insert(makeTurn({ userId: "user-alice" }));
    expect(store.searchByQuery("", { userId: "user-alice", limit: 5 })).toEqual([]);
    expect(store.searchByQuery("  ", { userId: "user-alice", limit: 5 })).toEqual([]);
  });

  it("searchByQuery() respects limit", () => {
    for (let i = 0; i < 10; i++) {
      store.insert(makeTurn({ content: `authentication step ${i}`, messageIndex: i, userId: "user-alice" }));
    }
    const hits = store.searchByQuery("authentication", { userId: "user-alice", limit: 3 });
    expect(hits).toHaveLength(3);
  });

  it("searchByQuery() orders by relevance descending (higher score first)", () => {
    // First turn: 'moonstone' appears 3 times → higher BM25
    store.insert(makeTurn({ content: "moonstone moonstone moonstone the secret vault", userId: "user-alice", messageIndex: 0 }));
    // Second turn: 'moonstone' appears once
    store.insert(makeTurn({ content: "the vault contains one moonstone crystal", userId: "user-alice", messageIndex: 1 }));
    const hits = store.searchByQuery("moonstone", { userId: "user-alice", limit: 5 });
    expect(hits).toHaveLength(2);
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score);
  });

  // ── multi-tenant user_id filter ───────────────────────────────────────────

  it("searchByQuery() scopes results to user_id — X never sees Y's turns", () => {
    store.insert(makeTurn({ content: "moonstone secret", userId: "user-alice" }));
    store.insert(makeTurn({ content: "moonstone other", userId: "user-bob" }));

    const aliceHits = store.searchByQuery("moonstone", { userId: "user-alice", limit: 10 });
    const bobHits = store.searchByQuery("moonstone", { userId: "user-bob", limit: 10 });

    expect(aliceHits).toHaveLength(1);
    expect(aliceHits[0].row.userId).toBe("user-alice");

    expect(bobHits).toHaveLength(1);
    expect(bobHits[0].row.userId).toBe("user-bob");
  });

  it("searchByQuery() with userId=null only returns rows with null user_id", () => {
    store.insert(makeTurn({ content: "shared fact", userId: undefined }));
    store.insert(makeTurn({ content: "shared fact", userId: "user-alice" }));

    const nullHits = store.searchByQuery("shared", { userId: null, limit: 10 });
    expect(nullHits.every(h => h.row.userId === null)).toBe(true);
  });

  // ── project filter ────────────────────────────────────────────────────────

  it("searchByQuery() scopes results by project when provided", () => {
    store.insert(makeTurn({ content: "deploy configuration", project: "proj-a", userId: "user-alice" }));
    store.insert(makeTurn({ content: "deploy configuration", project: "proj-b", userId: "user-alice" }));

    const projAHits = store.searchByQuery("deploy", { userId: "user-alice", project: "proj-a", limit: 10 });
    expect(projAHits).toHaveLength(1);
    expect(projAHits[0].row.project).toBe("proj-a");
  });

  it("searchByQuery() without project filter returns all matching rows for that user", () => {
    store.insert(makeTurn({ content: "deploy configuration", project: "proj-a", userId: "user-alice" }));
    store.insert(makeTurn({ content: "deploy configuration", project: "proj-b", userId: "user-alice" }));

    const hits = store.searchByQuery("deploy", { userId: "user-alice", limit: 10 });
    expect(hits).toHaveLength(2);
  });

  // ── getBySessionId ────────────────────────────────────────────────────────

  it("getBySessionId() returns all turns for a session ordered by message_index", () => {
    store.insert(makeTurn({ sessionId: "sess-x", content: "First", messageIndex: 0 }));
    store.insert(makeTurn({ sessionId: "sess-x", content: "Second", messageIndex: 1 }));
    store.insert(makeTurn({ sessionId: "sess-y", content: "Other", messageIndex: 0 }));

    const rows = store.getBySessionId("sess-x");
    expect(rows).toHaveLength(2);
    expect(rows[0].content).toBe("First");
    expect(rows[1].content).toBe("Second");
  });

  it("getBySessionId() returns empty array for unknown session", () => {
    expect(store.getBySessionId("nonexistent")).toEqual([]);
  });

  // ── deleteBySessionId ─────────────────────────────────────────────────────

  it("deleteBySessionId() removes all turns for a session", () => {
    store.insert(makeTurn({ sessionId: "sess-del", content: "turn A", messageIndex: 0 }));
    store.insert(makeTurn({ sessionId: "sess-del", content: "turn B", messageIndex: 1 }));
    store.insert(makeTurn({ sessionId: "sess-keep", content: "keep this", messageIndex: 0 }));

    store.deleteBySessionId("sess-del");

    expect(store.getBySessionId("sess-del")).toEqual([]);
    expect(store.getBySessionId("sess-keep")).toHaveLength(1);
    expect(store.count()).toBe(1);
  });

  // ── FTS cascade delete ────────────────────────────────────────────────────

  it("FTS rows are removed after deleteBySessionId (cascade via triggers)", () => {
    store.insert(makeTurn({ sessionId: "sess-fts", content: "crypographic hash function", userId: "user-alice", messageIndex: 0 }));
    const before = store.searchByQuery("crypographic", { userId: "user-alice", limit: 5 });
    expect(before).toHaveLength(1);

    store.deleteBySessionId("sess-fts");

    const after = store.searchByQuery("crypographic", { userId: "user-alice", limit: 5 });
    expect(after).toHaveLength(0);
  });

  // ── count ─────────────────────────────────────────────────────────────────

  it("count() returns 0 on an empty store", () => {
    expect(store.count()).toBe(0);
  });

  it("count() reflects inserted rows", () => {
    store.insert(makeTurn({ messageIndex: 0 }));
    store.insert(makeTurn({ messageIndex: 1 }));
    expect(store.count()).toBe(2);
  });

  it("count() decrements after deletion", () => {
    store.insert(makeTurn({ sessionId: "del-me", messageIndex: 0 }));
    store.insert(makeTurn({ sessionId: "keep-me", messageIndex: 0 }));
    store.deleteBySessionId("del-me");
    expect(store.count()).toBe(1);
  });

  // ── punctuation / FTS safety ──────────────────────────────────────────────

  it("searchByQuery() handles queries with special FTS characters without throwing", () => {
    store.insert(makeTurn({ content: "what is the wizard true name", userId: "user-alice" }));
    // apostrophes, quotes, parens — potential FTS5 parse errors
    expect(() => store.searchByQuery("what's the wizard's true name", { userId: "user-alice", limit: 5 })).not.toThrow();
  });
});
