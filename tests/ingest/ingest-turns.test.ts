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
});
