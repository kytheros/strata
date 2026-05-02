/**
 * Unit tests for PgKnowledgeTurnStore.
 *
 * Gated on the STRATA_PG_TEST_URL environment variable. When unset, the entire
 * suite is skipped cleanly so CI without a Postgres instance still passes.
 *
 * To run against a real Postgres instance:
 *   STRATA_PG_TEST_URL=postgres://localhost/strata_test \
 *     npm test --prefix strata -- tests/unit/pg-knowledge-turn-store.test.ts
 *
 * Coverage (mirrors sqlite-knowledge-turn-store.test.ts):
 * - insert / retrieve round-trip
 * - All stored fields preserved correctly
 * - bulkInsert atomicity and ID return
 * - searchByQuery: single token, multi-token OR, score shape, score ordering
 * - searchByQuery: empty query guard
 * - searchByQuery: limit respected
 * - searchByQuery: multi-tenant user_id isolation
 * - searchByQuery: project filter
 * - getBySessionId: ordered by message_index ASC
 * - deleteBySessionId: removes rows; search returns empty afterward
 * - count(): reflects inserts and deletes
 *
 * Spec: 2026-05-01-tirqdp-community-port-design.md
 * Ticket: TIRQDP-1.3
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { PgKnowledgeTurnStore } from "../../src/storage/pg/pg-knowledge-turn-store.js";
import type { KnowledgeTurnInput } from "../../src/storage/interfaces/knowledge-turn-store.js";

// ── env-gate ────────────────────────────────────────────────────────────────

const PG_URL = process.env.STRATA_PG_TEST_URL;

// Use describe.skip when the env var is not set so the suite is skipped
// cleanly without error output.
const describeOrSkip = PG_URL ? describe : describe.skip;

// ── DDL ─────────────────────────────────────────────────────────────────────

/**
 * Inline DDL for the knowledge_turns table.
 * Mirrors the content of migrations/0004_knowledge_turns.sql.
 * Applied once per test run in beforeAll; the table is truncated between tests.
 */
const KNOWLEDGE_TURNS_DDL = `
  CREATE TABLE IF NOT EXISTS knowledge_turns (
    turn_id     TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    project     TEXT,
    user_id     TEXT,
    speaker     TEXT NOT NULL CHECK(speaker IN ('user', 'assistant', 'system')),
    content     TEXT NOT NULL,
    message_index INTEGER NOT NULL DEFAULT 0,
    created_at  BIGINT NOT NULL,
    tsv tsvector GENERATED ALWAYS AS (
      to_tsvector('english', coalesce(content, ''))
    ) STORED
  )
`;

const KNOWLEDGE_TURNS_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_kt_session_msg  ON knowledge_turns(session_id, message_index)`,
  `CREATE INDEX IF NOT EXISTS idx_kt_project_ts   ON knowledge_turns(project, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_kt_user         ON knowledge_turns(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_kt_tsv          ON knowledge_turns USING GIN (tsv)`,
];

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

// ── suite ────────────────────────────────────────────────────────────────────

describeOrSkip("PgKnowledgeTurnStore", () => {
  let pool: pg.Pool;
  let store: PgKnowledgeTurnStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL, max: 5 });
    await pool.query(KNOWLEDGE_TURNS_DDL);
    for (const idx of KNOWLEDGE_TURNS_INDEXES) {
      await pool.query(idx);
    }
    store = new PgKnowledgeTurnStore(pool);
  });

  afterAll(async () => {
    await pool.query("DROP TABLE IF EXISTS knowledge_turns").catch(() => {});
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM knowledge_turns");
  });

  // ── insert / retrieve round-trip ───────────────────────────────────────────

  it("insert() returns a UUID and persists the row", async () => {
    const id = await store.insert(makeTurn());
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await store.count()).toBe(1);
  });

  it("insert() stores all fields correctly", async () => {
    const input = makeTurn({
      sessionId: "sess-abc",
      project: "proj-x",
      userId: "user-bob",
      speaker: "assistant",
      content: "Use bcrypt with cost factor 12",
      messageIndex: 3,
    });
    const id = await store.insert(input);
    const rows = await store.getBySessionId("sess-abc");
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

  // ── bulkInsert ─────────────────────────────────────────────────────────────

  it("bulkInsert() inserts all turns atomically", async () => {
    const turns = [
      makeTurn({ content: "First message", messageIndex: 0 }),
      makeTurn({ content: "Second message", messageIndex: 1 }),
      makeTurn({ content: "Third message", messageIndex: 2 }),
    ];
    await store.bulkInsert(turns);
    expect(await store.count()).toBe(3);
  });

  it("bulkInsert() returns inserted turn IDs", async () => {
    const turns = [makeTurn({ messageIndex: 0 }), makeTurn({ messageIndex: 1 })];
    const ids = await store.bulkInsert(turns);
    expect(ids).toHaveLength(2);
    ids.forEach(id => expect(id).toMatch(/^[0-9a-f-]{36}$/));
  });

  // ── searchByQuery — token search ────────────────────────────────────────────

  it("searchByQuery() finds turns matching a single token", async () => {
    await store.insert(makeTurn({ content: "The authentication token expires after 24 hours", userId: "user-alice" }));
    await store.insert(makeTurn({ content: "Nice weather today", userId: "user-alice" }));
    const hits = await store.searchByQuery("authentication", { userId: "user-alice", limit: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0].row.content).toContain("authentication");
  });

  it("searchByQuery() finds turns matching multiple tokens (OR)", async () => {
    await store.insert(makeTurn({ content: "The authentication token", userId: "user-alice" }));
    await store.insert(makeTurn({ content: "Token refresh logic", userId: "user-alice" }));
    await store.insert(makeTurn({ content: "Unrelated database config", userId: "user-alice" }));
    const hits = await store.searchByQuery("authentication token", { userId: "user-alice", limit: 10 });
    // Both "authentication token" and "Token refresh logic" match (token appears in both)
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it("searchByQuery() returns { row, score } shape with numeric score", async () => {
    await store.insert(makeTurn({ content: "bcrypt password hashing algorithm", userId: "user-alice" }));
    const hits = await store.searchByQuery("bcrypt", { userId: "user-alice", limit: 5 });
    expect(hits).toHaveLength(1);
    expect(typeof hits[0].score).toBe("number");
    expect(hits[0].score).toBeGreaterThan(0); // normalized: higher = more relevant
    expect(hits[0].row).toBeDefined();
    expect(hits[0].row.turnId).toBeDefined();
  });

  it("searchByQuery() returns empty array for empty query", async () => {
    await store.insert(makeTurn({ userId: "user-alice" }));
    expect(await store.searchByQuery("", { userId: "user-alice", limit: 5 })).toEqual([]);
    expect(await store.searchByQuery("  ", { userId: "user-alice", limit: 5 })).toEqual([]);
  });

  it("searchByQuery() respects limit", async () => {
    for (let i = 0; i < 10; i++) {
      await store.insert(makeTurn({ content: `authentication step ${i}`, messageIndex: i, userId: "user-alice" }));
    }
    const hits = await store.searchByQuery("authentication", { userId: "user-alice", limit: 3 });
    expect(hits).toHaveLength(3);
  });

  it("searchByQuery() orders by relevance descending (higher score first)", async () => {
    // First turn: 'moonstone' appears 3 times → higher ts_rank
    await store.insert(makeTurn({ content: "moonstone moonstone moonstone the secret vault", userId: "user-alice", messageIndex: 0 }));
    // Second turn: 'moonstone' appears once
    await store.insert(makeTurn({ content: "the vault contains one moonstone crystal", userId: "user-alice", messageIndex: 1 }));
    const hits = await store.searchByQuery("moonstone", { userId: "user-alice", limit: 5 });
    expect(hits).toHaveLength(2);
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score);
  });

  // ── multi-tenant user_id isolation ─────────────────────────────────────────

  it("searchByQuery() scopes results to user_id — X never sees Y's turns", async () => {
    await store.insert(makeTurn({ content: "moonstone secret", userId: "user-alice" }));
    await store.insert(makeTurn({ content: "moonstone other", userId: "user-bob" }));

    const aliceHits = await store.searchByQuery("moonstone", { userId: "user-alice", limit: 10 });
    const bobHits   = await store.searchByQuery("moonstone", { userId: "user-bob",   limit: 10 });

    expect(aliceHits).toHaveLength(1);
    expect(aliceHits[0].row.userId).toBe("user-alice");

    expect(bobHits).toHaveLength(1);
    expect(bobHits[0].row.userId).toBe("user-bob");
  });

  it("searchByQuery() with userId=null only returns rows with null user_id", async () => {
    await store.insert(makeTurn({ content: "shared fact", userId: undefined }));
    await store.insert(makeTurn({ content: "shared fact", userId: "user-alice" }));

    const nullHits = await store.searchByQuery("shared", { userId: null, limit: 10 });
    expect(nullHits.every(h => h.row.userId === null)).toBe(true);
  });

  // ── project filter ─────────────────────────────────────────────────────────

  it("searchByQuery() scopes results by project when provided", async () => {
    await store.insert(makeTurn({ content: "deploy configuration", project: "proj-a", userId: "user-alice" }));
    await store.insert(makeTurn({ content: "deploy configuration", project: "proj-b", userId: "user-alice" }));

    const projAHits = await store.searchByQuery("deploy", { userId: "user-alice", project: "proj-a", limit: 10 });
    expect(projAHits).toHaveLength(1);
    expect(projAHits[0].row.project).toBe("proj-a");
  });

  it("searchByQuery() without project filter returns all matching rows for that user", async () => {
    await store.insert(makeTurn({ content: "deploy configuration", project: "proj-a", userId: "user-alice" }));
    await store.insert(makeTurn({ content: "deploy configuration", project: "proj-b", userId: "user-alice" }));

    const hits = await store.searchByQuery("deploy", { userId: "user-alice", limit: 10 });
    expect(hits).toHaveLength(2);
  });

  // ── getBySessionId ─────────────────────────────────────────────────────────

  it("getBySessionId() returns all turns for a session ordered by message_index", async () => {
    await store.insert(makeTurn({ sessionId: "sess-x", content: "First",  messageIndex: 0 }));
    await store.insert(makeTurn({ sessionId: "sess-x", content: "Second", messageIndex: 1 }));
    await store.insert(makeTurn({ sessionId: "sess-y", content: "Other",  messageIndex: 0 }));

    const rows = await store.getBySessionId("sess-x");
    expect(rows).toHaveLength(2);
    expect(rows[0].content).toBe("First");
    expect(rows[1].content).toBe("Second");
  });

  it("getBySessionId() returns empty array for unknown session", async () => {
    expect(await store.getBySessionId("nonexistent")).toEqual([]);
  });

  // ── deleteBySessionId ──────────────────────────────────────────────────────

  it("deleteBySessionId() removes all turns for a session", async () => {
    await store.insert(makeTurn({ sessionId: "sess-del",  content: "turn A", messageIndex: 0 }));
    await store.insert(makeTurn({ sessionId: "sess-del",  content: "turn B", messageIndex: 1 }));
    await store.insert(makeTurn({ sessionId: "sess-keep", content: "keep this", messageIndex: 0 }));

    await store.deleteBySessionId("sess-del");

    expect(await store.getBySessionId("sess-del")).toEqual([]);
    expect(await store.getBySessionId("sess-keep")).toHaveLength(1);
    expect(await store.count()).toBe(1);
  });

  it("tsvector search returns empty after deleteBySessionId", async () => {
    await store.insert(makeTurn({ sessionId: "sess-fts", content: "cryptographic hash function", userId: "user-alice", messageIndex: 0 }));
    const before = await store.searchByQuery("cryptographic", { userId: "user-alice", limit: 5 });
    expect(before).toHaveLength(1);

    await store.deleteBySessionId("sess-fts");

    const after = await store.searchByQuery("cryptographic", { userId: "user-alice", limit: 5 });
    expect(after).toHaveLength(0);
  });

  // ── count ──────────────────────────────────────────────────────────────────

  it("count() returns 0 on an empty store", async () => {
    expect(await store.count()).toBe(0);
  });

  it("count() reflects inserted rows", async () => {
    await store.insert(makeTurn({ messageIndex: 0 }));
    await store.insert(makeTurn({ messageIndex: 1 }));
    expect(await store.count()).toBe(2);
  });

  it("count() decrements after deletion", async () => {
    await store.insert(makeTurn({ sessionId: "del-me",   messageIndex: 0 }));
    await store.insert(makeTurn({ sessionId: "keep-me",  messageIndex: 0 }));
    await store.deleteBySessionId("del-me");
    expect(await store.count()).toBe(1);
  });

  // ── score normalization contract ───────────────────────────────────────────

  it("score normalization: scores lie in [0, 1] range", async () => {
    for (let i = 0; i < 5; i++) {
      await store.insert(makeTurn({
        content: `authentication security token expire session refresh ${i}`,
        userId: "user-alice",
        messageIndex: i,
      }));
    }
    const hits = await store.searchByQuery("authentication security", { userId: "user-alice", limit: 10 });
    for (const hit of hits) {
      expect(hit.score).toBeGreaterThanOrEqual(0);
      expect(hit.score).toBeLessThanOrEqual(1);
    }
  });

  // ── query safety ───────────────────────────────────────────────────────────

  it("searchByQuery() handles queries with special characters without throwing", async () => {
    await store.insert(makeTurn({ content: "what is the wizard true name", userId: "user-alice" }));
    // apostrophes, single quotes, parens — potential tsvector query parse errors
    await expect(
      store.searchByQuery("what's the wizard's true name", { userId: "user-alice", limit: 5 })
    ).resolves.not.toThrow();
  });
});
