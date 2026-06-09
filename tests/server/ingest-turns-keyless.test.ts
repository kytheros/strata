import { describe, it, expect } from "vitest";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { SqliteKnowledgeTurnStore } from "../../src/storage/sqlite-knowledge-turn-store.js";
import { ingestTurns } from "../../src/ingest/ingest-turns.js";

describe("ingest_turns keyless (no embedding provider)", () => {
  it("writes FTS turns + chunks + entries and reports embedded:false when embedderPresent=false", async () => {
    // Test the ingestTurns function directly with embedderPresent:false to simulate a keyless deployment.
    // This tests the core write-path without dependence on whether the test env has a GEMINI_API_KEY.
    const db = openDatabase(":memory:");
    const knowledge = new SqliteKnowledgeStore(db);
    const documents = new SqliteDocumentStore(db);
    const turnStore = new SqliteKnowledgeTurnStore(db, null); // FTS-only, no embedder

    const res = await ingestTurns(
      { turnStore, documents, knowledge, embedderPresent: false },
      {
        sessionId: "s", userId: "default", messages: [
          { speaker: "user", content: "deploy notes for the api" },
          { speaker: "assistant", content: "use blue green on ecs" },
        ]
      }
    );
    expect(res.turnsWritten).toBe(2);     // FTS-only turn store wired
    expect(res.embedded).toBe(false);
    expect(res.chunksWritten).toBeGreaterThanOrEqual(1);
  });
});
