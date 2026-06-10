import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { SqliteKnowledgeTurnStore } from "../../src/storage/sqlite-knowledge-turn-store.js";
import { ingestTurns, type IngestTurnsInput } from "../../src/ingest/ingest-turns.js";

function input(overrides: Partial<IngestTurnsInput> = {}): IngestTurnsInput {
  return {
    sessionId: "sess-1", project: "p", userId: "u1",
    messages: [
      { speaker: "user", content: "how do I deploy the worker" },
      { speaker: "assistant", content: "run npx wrangler deploy from the worker dir" },
    ],
    ...overrides,
  };
}

describe("ingestTurns", () => {
  let db: ReturnType<typeof openDatabase>;
  let knowledge: SqliteKnowledgeStore;
  let documents: SqliteDocumentStore;
  let turnStore: SqliteKnowledgeTurnStore;
  beforeEach(() => {
    db = openDatabase(":memory:");
    knowledge = new SqliteKnowledgeStore(db);
    documents = new SqliteDocumentStore(db);
    turnStore = new SqliteKnowledgeTurnStore(db, null); // keyless FTS-only
  });

  it("writes turns, chunks, and knowledge entries for a session", async () => {
    const res = await ingestTurns({ turnStore, documents, knowledge, embedderPresent: false }, input());
    expect(res.turnsWritten).toBe(2);
    expect(res.chunksWritten).toBeGreaterThanOrEqual(1);
    expect(res.embedded).toBe(false);
    expect(res.warnings.some((w) => /no embedding provider/i.test(w))).toBe(true);
    expect((await turnStore.getBySessionId("sess-1")).length).toBe(2);
    expect((await documents.getBySession("sess-1")).length).toBe(res.chunksWritten);
  });

  it("replace-session: re-ingesting the same sessionId does not duplicate", async () => {
    await ingestTurns({ turnStore, documents, knowledge, embedderPresent: false }, input());
    const res2 = await ingestTurns({ turnStore, documents, knowledge, embedderPresent: false }, input());
    expect((await turnStore.getBySessionId("sess-1")).length).toBe(2); // not 4
    expect(res2.turnsWritten).toBe(2);
  });

  it("rejects invalid input", async () => {
    await expect(ingestTurns({ turnStore, documents, knowledge, embedderPresent: false }, input({ messages: [] })))
      .rejects.toThrow(/messages/i);
  });

  it("null turnStore: skips turns, still writes chunks + entries, warns", async () => {
    const res = await ingestTurns({ turnStore: null, documents, knowledge, embedderPresent: false }, input());
    expect(res.turnsWritten).toBe(0);
    expect(res.chunksWritten).toBeGreaterThanOrEqual(1);
    expect(res.warnings.some((w) => /turn store unavailable/i.test(w))).toBe(true);
  });

  it("skips empty-content turns instead of rejecting the whole session, and warns", async () => {
    const res = await ingestTurns({ turnStore, documents, knowledge, embedderPresent: false }, input({
      messages: [
        { speaker: "user", content: "how do I deploy the worker" },
        { speaker: "assistant", content: "   " }, // whitespace-only
        { speaker: "assistant", content: "" },     // empty
        { speaker: "user", content: "thanks, that worked" },
      ],
    }));
    expect(res.turnsWritten).toBe(2); // the two empties dropped, not rejected
    expect((await turnStore.getBySessionId("sess-1")).length).toBe(2);
    expect(res.warnings.some((w) => /skipped 2 empty/i.test(w))).toBe(true);
  });

  it("all-empty messages throw BEFORE replace-session deletes (no data loss)", async () => {
    // Seed a real session first.
    await ingestTurns({ turnStore, documents, knowledge, embedderPresent: false }, input());
    expect((await turnStore.getBySessionId("sess-1")).length).toBe(2);
    // An all-empty re-ingest must throw and leave the existing session intact.
    await expect(ingestTurns({ turnStore, documents, knowledge, embedderPresent: false }, input({
      messages: [{ speaker: "user", content: "" }, { speaker: "assistant", content: "  " }],
    }))).rejects.toThrow(/empty content/i);
    expect((await turnStore.getBySessionId("sess-1")).length).toBe(2); // untouched
  });
});
