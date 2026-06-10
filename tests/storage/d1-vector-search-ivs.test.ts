/**
 * D1VectorSearch implements IVectorSearch — conformance tests.
 *
 * Tests the three new methods: searchAll, searchDocumentChunks (stub),
 * searchTurnEmbeddings (with user-scope isolation).
 *
 * Uses Miniflare for a local D1-compatible database.
 *
 * Spec: 2026-06-04-dtl-pr3-d1-plan.md
 * PR: feat/dtl-pr3-d1
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Miniflare } from "miniflare";
import { createD1Storage } from "../../src/storage/d1/index.js";
import { D1VectorSearch } from "../../src/storage/d1/d1-vector-search.js";
import type { IVectorSearch } from "../../src/extensions/embeddings/vector-search.js";

const USER_A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

describe("D1VectorSearch implements IVectorSearch", () => {
  let mf: Miniflare;
  let db: any;
  let vs: D1VectorSearch;

  beforeEach(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: ["STRATA_DB"],
    });
    db = await mf.getD1Database("STRATA_DB");
    await createD1Storage({ d1: db, userId: USER_A });
    vs = new D1VectorSearch(db, "test-model");
  });

  afterEach(async () => {
    await mf.dispose();
  });

  it("satisfies IVectorSearch interface at runtime (structural check)", () => {
    // Type-level: if D1VectorSearch doesn't implement IVectorSearch, tsc fails.
    const ivs: IVectorSearch = vs;
    expect(typeof ivs.search).toBe("function");
    expect(typeof ivs.searchAll).toBe("function");
    expect(typeof ivs.searchDocumentChunks).toBe("function");
    expect(typeof ivs.searchTurnEmbeddings).toBe("function");
  });

  it("searchAll returns empty array on empty embeddings table", async () => {
    const results = await vs.searchAll(new Float32Array(768).fill(0.1), 10);
    expect(results).toEqual([]);
  });

  it("searchDocumentChunks returns empty array (no document_chunks table in D1)", async () => {
    const results = await vs.searchDocumentChunks(
      new Float32Array(768).fill(0.1),
      10
    );
    expect(results).toEqual([]);
  });

  it("searchTurnEmbeddings returns empty array on empty knowledge_turn_embeddings", async () => {
    const results = await vs.searchTurnEmbeddings(
      new Float32Array(768).fill(0.1),
      10,
      { userId: USER_A }
    );
    expect(results).toEqual([]);
  });

  it("searchTurnEmbeddings returns ranked results for seeded turn embeddings", async () => {
    // Seed a turn + its embedding directly via D1
    const turnId = "turn-abc-123";
    await db
      .prepare(
        "INSERT INTO knowledge_turns (turn_id, session_id, project, user_id, speaker, content, message_index, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(turnId, "sess-1", "proj", USER_A, "user", "hello", 0, Date.now())
      .run();

    // Build a 768-d float32 blob (matching test-model's dimension)
    const vec = new Float32Array(768).fill(0.9);
    const ab = vec.buffer as ArrayBuffer;
    await db
      .prepare(
        "INSERT INTO knowledge_turn_embeddings (turn_id, embedding, model, created_at, format) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(turnId, ab, "test-model", Date.now(), "float32")
      .run();

    const results = await vs.searchTurnEmbeddings(
      new Float32Array(768).fill(0.9),
      10,
      { userId: USER_A }
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entryId).toBe(turnId);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("searchTurnEmbeddings respects userId scope — no user-B bleed", async () => {
    const turnIdA = "turn-user-a-001";
    const turnIdB = "turn-user-b-001";

    // Seed turns for two users
    await db
      .prepare(
        "INSERT INTO knowledge_turns (turn_id, session_id, project, user_id, speaker, content, message_index, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(turnIdA, "sess-a", "proj", USER_A, "user", "turn for a", 0, Date.now())
      .run();
    await db
      .prepare(
        "INSERT INTO knowledge_turns (turn_id, session_id, project, user_id, speaker, content, message_index, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(turnIdB, "sess-b", "proj", USER_B, "user", "turn for b", 0, Date.now())
      .run();

    // Seed embeddings for both turns
    const vecA = new Float32Array(768).fill(0.9);
    const vecB = new Float32Array(768).fill(0.1);
    await db
      .prepare(
        "INSERT INTO knowledge_turn_embeddings (turn_id, embedding, model, created_at, format) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(turnIdA, vecA.buffer as ArrayBuffer, "test-model", Date.now(), "float32")
      .run();
    await db
      .prepare(
        "INSERT INTO knowledge_turn_embeddings (turn_id, embedding, model, created_at, format) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(turnIdB, vecB.buffer as ArrayBuffer, "test-model", Date.now(), "float32")
      .run();

    // Search as user-A — should see turnIdA, NOT turnIdB
    const results = await vs.searchTurnEmbeddings(
      new Float32Array(768).fill(0.9),
      10,
      { userId: USER_A }
    );
    const returnedIds = results.map((r) => r.entryId);
    expect(returnedIds).toContain(turnIdA);
    expect(returnedIds).not.toContain(turnIdB);
  });
});
