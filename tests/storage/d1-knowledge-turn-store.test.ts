/**
 * D1KnowledgeTurnStore tests.
 *
 * Uses Miniflare to spin up a local D1-compatible SQLite database.
 * Tests schema presence (RED before T2), CRUD operations, FTS5 search,
 * user isolation, bulk insert chunking, and embedder injection.
 *
 * Spec: 2026-06-04-dtl-pr3-d1-plan.md
 * PR: feat/dtl-pr3-d1
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Miniflare } from "miniflare";
import { createD1Storage } from "../../src/storage/d1/index.js";

const USER_A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";

// ── T1: Schema presence ──────────────────────────────────────────────────────

describe("D1KnowledgeTurnStore", () => {
  let mf: Miniflare;
  let db: any;

  beforeEach(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: ["STRATA_DB"],
    });
    db = await mf.getD1Database("STRATA_DB");
    await createD1Storage({ d1: db, userId: USER_A });
  });

  afterEach(async () => {
    await mf.dispose();
  });

  it("knowledge_turn_embeddings table exists after schema init", async () => {
    const result = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_turn_embeddings'"
      )
      .first();
    expect(result).not.toBeNull();
    expect(result?.name).toBe("knowledge_turn_embeddings");
  });

  it("schema version is '5' after schema init", async () => {
    const result = await db
      .prepare("SELECT value FROM index_meta WHERE key='schema_version'")
      .first<{ value: string }>();
    expect(result?.value).toBe("5");
  });
});

// ── T3: D1KnowledgeTurnStore CRUD ────────────────────────────────────────────

describe("D1KnowledgeTurnStore CRUD", () => {
  let mf: Miniflare;
  let db: any;
  let store: import("../../src/storage/d1/d1-knowledge-turn-store.js").D1KnowledgeTurnStore;

  beforeEach(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: ["STRATA_DB"],
    });
    db = await mf.getD1Database("STRATA_DB");
    await createD1Storage({ d1: db, userId: USER_A });

    const { D1KnowledgeTurnStore } = await import(
      "../../src/storage/d1/d1-knowledge-turn-store.js"
    );
    store = new D1KnowledgeTurnStore(db);
  });

  afterEach(async () => {
    await mf.dispose();
  });

  it("insert returns a UUID turn_id", async () => {
    const id = await store.insert({
      sessionId: "sess-1",
      speaker: "user",
      content: "hello world",
      messageIndex: 0,
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("getBySessionId returns inserted turns in order", async () => {
    await store.insert({
      sessionId: "s1",
      speaker: "user",
      content: "first",
      messageIndex: 0,
    });
    await store.insert({
      sessionId: "s1",
      speaker: "assistant",
      content: "second",
      messageIndex: 1,
    });
    const rows = await store.getBySessionId("s1");
    expect(rows).toHaveLength(2);
    expect(rows[0].content).toBe("first");
    expect(rows[1].content).toBe("second");
  });

  it("bulkInsert chunks at 50 without exceeding D1 batch limit", async () => {
    const turns = Array.from({ length: 75 }, (_, i) => ({
      sessionId: "bulk-sess",
      speaker: "user" as const,
      content: `turn ${i}`,
      messageIndex: i,
    }));
    const ids = await store.bulkInsert(turns);
    expect(ids).toHaveLength(75);
    const rows = await store.getBySessionId("bulk-sess");
    expect(rows).toHaveLength(75);
  });

  it("searchByQuery returns FTS5 matches scoped by userId", async () => {
    await store.insert({
      sessionId: "s1",
      userId: "user-a",
      speaker: "user",
      content: "typescript debugging fix",
      messageIndex: 0,
    });
    await store.insert({
      sessionId: "s2",
      userId: "user-b",
      speaker: "user",
      content: "typescript debugging fix",
      messageIndex: 0,
    });
    const hits = await store.searchByQuery("typescript", {
      userId: "user-a",
      limit: 10,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].row.userId).toBe("user-a");
  });

  it("getByIds returns rows for given turn ids", async () => {
    const id1 = await store.insert({
      sessionId: "s1",
      speaker: "user",
      content: "foo",
      messageIndex: 0,
    });
    const id2 = await store.insert({
      sessionId: "s1",
      speaker: "assistant",
      content: "bar",
      messageIndex: 1,
    });
    const rows = await store.getByIds([id1, id2]);
    expect(rows).toHaveLength(2);
  });

  it("deleteBySessionId removes turns and FTS entries", async () => {
    await store.insert({
      sessionId: "s-del",
      speaker: "user",
      content: "to be deleted",
      messageIndex: 0,
    });
    await store.deleteBySessionId("s-del");
    const rows = await store.getBySessionId("s-del");
    expect(rows).toHaveLength(0);
    const hits = await store.searchByQuery("deleted", {
      userId: undefined,
      limit: 10,
    });
    expect(hits).toHaveLength(0);
  });

  it("count returns total turn count across all users", async () => {
    await store.insert({
      sessionId: "s1",
      speaker: "user",
      content: "a",
      messageIndex: 0,
    });
    await store.insert({
      sessionId: "s2",
      speaker: "user",
      content: "b",
      messageIndex: 0,
    });
    expect(await store.count()).toBe(2);
  });

  it("setEmbedder stores embeddings in knowledge_turn_embeddings on insert", async () => {
    const fakeEmbedder = {
      embed: async (_t: string) => new Float32Array(768).fill(0.1),
      embedBatch: async (ts: string[]) =>
        ts.map(() => new Float32Array(768).fill(0.1)),
      dimensions: 768,
      modelName: "test-model",
      supportsQuantization: false,
    };
    store.setEmbedder(fakeEmbedder as any);
    const id = await store.insert({
      sessionId: "emb-sess",
      speaker: "user",
      content: "embed me",
      messageIndex: 0,
    });
    // Wait for fire-and-forget embed
    await new Promise((r) => setTimeout(r, 200));
    const row = await db
      .prepare(
        "SELECT * FROM knowledge_turn_embeddings WHERE turn_id = ?"
      )
      .bind(id)
      .first();
    expect(row).not.toBeNull();
    expect(row?.model).toBe("test-model");
  });

  it("searchTurnEmbeddings (via D1VectorSearch) respects userId scope — no user-B bleed", async () => {
    // Seed turns for user-A and user-B
    const idA = await store.insert({
      sessionId: "sa",
      userId: "user-scope-a",
      speaker: "user",
      content: "scoped turn for user a",
      messageIndex: 0,
    });
    const idB = await store.insert({
      sessionId: "sb",
      userId: "user-scope-b",
      speaker: "user",
      content: "scoped turn for user b",
      messageIndex: 0,
    });

    // Seed embeddings directly for both turns
    const vecA = new Float32Array(768).fill(0.9);
    const vecB = new Float32Array(768).fill(0.1);
    const abA = vecA.buffer as ArrayBuffer;
    const abB = vecB.buffer as ArrayBuffer;
    await db
      .prepare(
        "INSERT INTO knowledge_turn_embeddings (turn_id, embedding, model, created_at, format) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(idA, abA, "test-model", Date.now(), "float32")
      .run();
    await db
      .prepare(
        "INSERT INTO knowledge_turn_embeddings (turn_id, embedding, model, created_at, format) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(idB, abB, "test-model", Date.now(), "float32")
      .run();

    const { D1VectorSearch } = await import(
      "../../src/storage/d1/d1-vector-search.js"
    );
    const vs = new D1VectorSearch(db, "test-model");
    const results = await vs.searchTurnEmbeddings(
      new Float32Array(768).fill(0.9),
      10,
      { userId: "user-scope-a" }
    );

    const returnedIds = results.map((r) => r.entryId);
    expect(returnedIds).toContain(idA);
    expect(returnedIds).not.toContain(idB);
  });
});
