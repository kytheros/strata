/**
 * Test: PgKnowledgeTurnStore — integration test verifying 0004 migration lands.
 *
 * Requires Postgres at PG_URL. Skips gracefully when unavailable.
 *
 * Validates (issue kytheros/strata#9):
 * - After createSchema() the knowledge_turns table exists
 * - PgKnowledgeTurnStore.insert() succeeds
 * - PgKnowledgeTurnStore.search() returns inserted turns
 * - PgKnowledgeTurnStore.getBySession() returns turns by session
 *
 * Issue: kytheros/strata#9 (0004_knowledge_turns.sql applied by runner)
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import pg from "pg";
import { createSchema, dropSchema } from "../../src/storage/pg/schema.js";
import { PgKnowledgeTurnStore } from "../../src/storage/pg/pg-knowledge-turn-store.js";
import type { KnowledgeTurnInput } from "../../src/storage/interfaces/knowledge-turn-store.js";

const PG_URL =
  process.env.PG_URL || "postgresql://postgres:test@localhost:5432/postgres";

function makeTurn(overrides: Partial<KnowledgeTurnInput> = {}): KnowledgeTurnInput {
  return {
    sessionId: `session-${Date.now()}`,
    project: "test-project",
    userId: null,
    speaker: "user",
    content: "test knowledge turn content",
    messageIndex: 0,
    ...overrides,
  };
}

describe("PgKnowledgeTurnStore (#9)", () => {
  let pool: pg.Pool | undefined;
  let store: PgKnowledgeTurnStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL, max: 3 });
    try {
      await pool.query("SELECT 1");
    } catch {
      console.log(
        "[pg-kt-test] Postgres not available — skipping PgKnowledgeTurnStore tests"
      );
      await pool.end();
      pool = undefined;
    }
  });

  beforeEach(async () => {
    if (!pool) return;
    await dropSchema(pool);
    await createSchema(pool);
    store = new PgKnowledgeTurnStore(pool);
  });

  afterAll(async () => {
    if (pool) {
      await dropSchema(pool).catch(() => {});
      await pool.end();
    }
  });

  it("knowledge_turns table exists after createSchema", async () => {
    if (!pool) return;

    const { rows } = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='knowledge_turns'"
    );
    expect(rows.length).toBe(1);
  });

  it("has expected columns from 0004 migration", async () => {
    if (!pool) return;

    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='knowledge_turns' ORDER BY ordinal_position`
    );
    const cols = rows.map((r) => r.column_name);
    expect(cols).toContain("turn_id");
    expect(cols).toContain("session_id");
    expect(cols).toContain("speaker");
    expect(cols).toContain("content");
    expect(cols).toContain("tsv"); // generated tsvector column
  });

  it("insert() persists a turn and returns a turn_id", async () => {
    if (!pool) return;

    const turnId = await store.insert(makeTurn());
    expect(typeof turnId).toBe("string");
    expect(turnId.length).toBeGreaterThan(0);

    const { rows } = await pool.query<{ turn_id: string }>(
      "SELECT turn_id FROM knowledge_turns WHERE turn_id = $1",
      [turnId]
    );
    expect(rows.length).toBe(1);
  });

  it("searchByQuery() returns turns matching the query", async () => {
    if (!pool) return;

    const sid = `session-search-${Date.now()}`;
    await store.insert(
      makeTurn({
        sessionId: sid,
        content: "the quick brown fox jumps over the lazy dog",
      })
    );

    const hits = await store.searchByQuery("quick fox", {
      userId: undefined,
      limit: 5,
    });
    expect(hits.length).toBeGreaterThan(0);
    const contents = hits.map((h) => h.row.content);
    expect(contents.some((c) => c.includes("quick brown fox"))).toBe(true);
  });

  it("getBySessionId() returns turns for the given session_id", async () => {
    if (!pool) return;

    const sid = `session-get-${Date.now()}`;
    await store.insert(makeTurn({ sessionId: sid, content: "turn one" }));
    await store.insert(makeTurn({ sessionId: sid, content: "turn two" }));
    await store.insert(makeTurn({ sessionId: "other-session", content: "different" }));

    const turns = await store.getBySessionId(sid);
    expect(turns.length).toBe(2);
    const contents = turns.map((t) => t.content);
    expect(contents).toContain("turn one");
    expect(contents).toContain("turn two");
  });

  it("schema_migrations records 0004 as applied", async () => {
    if (!pool) return;

    const { rows } = await pool.query<{ version: string; name: string }>(
      "SELECT version, name FROM schema_migrations WHERE version = '0004'"
    );
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe("0004_knowledge_turns.sql");
  });
});
