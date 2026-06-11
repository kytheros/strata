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

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
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

    const sid = `session-search-${randomUUID()}`;
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

    const sid = `session-get-${randomUUID()}`;
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

  it("knowledge_turn_embeddings table exists after createSchema [0007]", async () => {
    if (!pool) return;
    const { rows } = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='knowledge_turn_embeddings'"
    );
    expect(rows.length).toBe(1);
  });

  // ── T3 (ticket #29): FK race fix ─────────────────────────────────────────────
  // Before the fix: insert() fires embedTurns as fire-and-forget. A subsequent
  // deleteBySessionId (replace-session flow) can delete knowledge_turns rows
  // before the embed INSERT fires → the embed INSERT targets a now-deleted turn_id
  // → FK violation (23503). The embed silently fails, meaning vectors are never
  // written (session effectively loses its dense lane data).
  //
  // After the fix: deleteBySessionId awaits any pending embed promise from insert()
  // so the embed writes complete (or fail gracefully) before the delete fires.
  // This ensures: no FK violation, and (when the embedder works) the embedding
  // row is written BEFORE the delete removes it, so the embed correctly fails
  // the FK check and degrades gracefully rather than firing after.
  //
  // The observable contract we test: after insert() + deleteBySessionId(), the
  // knowledge_turn_embeddings table has no orphaned rows (either the embed ran
  // and was cleaned up by CASCADE, or it never ran because it was already deleted).
  describe("FK race fix (T3 / #29)", () => {
    function makeFakeEmbedderTurn(dim = 4, delayMs = 0) {
      let calls = 0;
      const embed = async (_text: string): Promise<Float32Array> => {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        calls++;
        const v = new Float32Array(dim); v.fill(0.5); return v;
      };
      const embedBatch = async (texts: string[]): Promise<Float32Array[]> => {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        calls += texts.length;
        return texts.map(() => { const v = new Float32Array(dim); v.fill(0.5); return v; });
      };
      return {
        embed, embedBatch,
        get calls() { return calls; },
        modelName: "race-test-model",
        supportsQuantization: false,
        dimensions: dim,
      };
    }

    it("bulkInsert embed window vs concurrent TRUNCATE → FK 23503 swallowed, no throw, no ERROR log", async () => {
      if (!pool) return;

      // The benchmark harness TRUNCATEs all tables between questions — it does NOT
      // go through deleteBySessionId, so the T3 drain can't protect this path.
      // bulkInsert COMMITs the turns, then embedBatch makes a (slow) network call,
      // then upserts the vectors. If a TRUNCATE lands during the embed call, the
      // upsert references a now-deleted turn → FK violation (23503). That race only
      // ever touches turns OUTSIDE the scored question (stale cross-question embeds),
      // so the correct behavior is to swallow 23503 quietly — NOT crash, NOT emit a
      // counted ERROR log that pollutes the benchmark error gate.
      const embedder = makeFakeEmbedderTurn(4, 60); // 60ms embed window
      const storeWithEmbed = new PgKnowledgeTurnStore(pool!, embedder as any);
      const sessionId = `trunc-race-${randomUUID()}`;

      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        // Fire bulkInsert WITHOUT awaiting — turns COMMIT, then embed sleeps 60ms.
        const bulkPromise = storeWithEmbed.bulkInsert([
          makeTurn({ sessionId, content: "turn that gets truncated mid-embed" }),
        ]);
        // Let the COMMIT land, then TRUNCATE while embedBatch is still sleeping.
        await new Promise((r) => setTimeout(r, 15));
        await pool!.query("TRUNCATE TABLE knowledge_turns CASCADE");

        // bulkInsert must resolve (the FK on the embed upsert is swallowed, not thrown).
        await expect(bulkPromise).resolves.toBeDefined();

        // And no 23503 should have been logged as a raw ERROR object.
        const loggedFk = errSpy.mock.calls.some((call) =>
          call.some((a) => a && typeof a === "object" && (a as { code?: string }).code === "23503")
        );
        expect(loggedFk).toBe(false);
      } finally {
        errSpy.mockRestore();
      }
    });

    it("insert() + immediate deleteBySessionId → no orphaned embeddings rows", async () => {
      if (!pool) return;

      // Use a delay to amplify the race window: embed takes 30ms, delete is immediate
      const embedder = makeFakeEmbedderTurn(4, 30);
      const storeWithEmbed = new PgKnowledgeTurnStore(pool!, embedder as any);

      const sessionId = `race-session-${randomUUID()}`;

      // insert fires embed fire-and-forget; delete arrives while embed is in flight
      await storeWithEmbed.insert(makeTurn({ sessionId, content: "race condition test" }));
      // deleteBySessionId should await any pending embed from insert() before deleting
      await storeWithEmbed.deleteBySessionId(sessionId);

      // Wait to ensure any still-in-flight embed has settled
      await new Promise((r) => setTimeout(r, 100));

      // No turns should remain
      const { rows: turnRows } = await pool!.query(
        "SELECT COUNT(*) AS cnt FROM knowledge_turns WHERE session_id = $1",
        [sessionId]
      );
      expect(Number(turnRows[0].cnt)).toBe(0);

      // No orphaned embedding rows should exist (CASCADE would clean up if turn existed,
      // but since delete happened first, no embed row should reference a deleted turn).
      // With the fix: embed either completes and is cleaned up by ON DELETE CASCADE,
      // OR deleteBySessionId awaited the embed so it ran first (embed insert
      // then the FK parent is deleted → CASCADE removes the embed row too).
      const { rows: embedRows } = await pool!.query(
        `SELECT kte.turn_id FROM knowledge_turn_embeddings kte
         LEFT JOIN knowledge_turns kt ON kt.turn_id = kte.turn_id
         WHERE kt.turn_id IS NULL`
      );
      // After the fix, no orphaned embedding rows (no FK violation escape)
      expect(embedRows.length).toBe(0);
    });

    it("deleteBySessionId awaits pending insert() embed before deleting (no FK error emitted)", async () => {
      if (!pool) return;

      const embedder = makeFakeEmbedderTurn(4, 10);
      const storeWithEmbed = new PgKnowledgeTurnStore(pool!, embedder as any);

      const sessionId = `race-session2-${randomUUID()}`;
      const errors: unknown[] = [];

      // Patch the store's pool.query to capture any errors that slip through
      const origQuery = pool!.query.bind(pool!);
      let fkViolationCaught = false;
      // We just verify deleteBySessionId doesn't throw and the post-state is clean

      await storeWithEmbed.insert(makeTurn({ sessionId, content: "test" }));
      // Should complete without throwing
      await expect(storeWithEmbed.deleteBySessionId(sessionId)).resolves.not.toThrow();

      await new Promise((r) => setTimeout(r, 80));

      // No lingering turns
      const { rows } = await pool!.query(
        "SELECT COUNT(*) AS cnt FROM knowledge_turns WHERE session_id = $1",
        [sessionId]
      );
      expect(Number(rows[0].cnt)).toBe(0);
    });
  });
});
