// strata/tests/benchmark/retrieve-dense-off.test.ts
/**
 * §8.1 item 8: CONFIG.benchmark.denseTurnLane.mode === "off" (default, env unset) →
 * the dense-turn fusion block in retrieve.ts is a true no-op.
 *
 * Strategy: build a minimal in-memory IngestedQuestion (empty DB, no embedder),
 * call retrieveQuestion with STRATA_DENSE_TURN_LANE unset, and assert the
 * returned searchResults equal what searchAsync returns directly — i.e.
 * fuseDenseTurnLane is not called / results are byte-identical to the pre-fusion path.
 *
 * Uses an empty corpus so searchAsync returns [] — both the direct call and
 * retrieveQuestion return [] with mode=off, proving the fusion block adds nothing.
 * No embedder, no network, no external files.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import { SqliteKnowledgeTurnStore } from "../../src/storage/sqlite-knowledge-turn-store.js";
import { retrieveQuestion } from "../../benchmarks/longmemeval/retrieve.js";
import type { IngestedQuestion } from "../../benchmarks/longmemeval/ingest.js";
import type { LongMemQuestion } from "../../benchmarks/longmemeval/types.js";

describe("retrieve.ts dense-turn-lane flag-off regression guard (§8.1 item 8)", () => {
  afterEach(() => {
    delete process.env.STRATA_DENSE_TURN_LANE;
  });

  it("mode=off → retrieveQuestion.searchResults equals direct searchAsync (fusion block is a no-op)", async () => {
    // Ensure the flag is off (default).
    delete process.env.STRATA_DENSE_TURN_LANE;
    const { CONFIG } = await import("../../src/config.js");
    expect(CONFIG.benchmark.denseTurnLane.mode).toBe("off");

    // ── Minimal in-memory setup (empty corpus, no embedder) ──────────────────
    const db = openDatabase(":memory:");
    const docStore = new SqliteDocumentStore(db);
    const knowledgeStore = new SqliteKnowledgeStore(db);
    const turnStore = new SqliteKnowledgeTurnStore(db); // no embedder
    // Add a turn with FTS5-matchable content so turnHits is non-empty.
    // This makes the test meaningful: if mode were "on", fuseDenseTurnLane would
    // inject the turn as a SearchResult — but with mode="off" it must not.
    await turnStore.bulkInsert([
      { sessionId: "s1", speaker: "assistant", content: "dragon hoards gold", messageIndex: 0 },
    ]);
    // No embedder → FTS5-only, no network calls.
    const searchEngine = new SqliteSearchEngine(docStore);
    searchEngine.setKnowledgeTurnStore(turnStore);

    // ── Minimal IngestedQuestion (empty document corpus) ─────────────────────
    const ingested: IngestedQuestion = {
      db,
      docStore,
      searchEngine,
      turnStore,
      knowledgeStore,
      questionId: "test-q-1",
      indexToSessionId: ["s1"],
      sessionCount: 1,
      chunkCount: 0,
      turnCount: 1,
      eventCount: 0,
    };

    const question: LongMemQuestion = {
      question_id: "test-q-1",
      question: "dragon gold",
      answer: "gold",
      question_type: "single-session-user",
      answer_session_ids: ["s1"],
      haystack_sessions: [],
      haystack_session_ids: ["s1"],
      haystack_dates: [],
    };

    // ── Call retrieveQuestion (no-vector, no sessionScoring) ─────────────────
    const result = await retrieveQuestion(question, ingested, undefined, { noVector: true });

    // ── Direct searchAsync call for comparison ────────────────────────────────
    // Empty document corpus → searchAsync returns [].
    const directResults = await searchEngine.searchAsync("dragon gold", { limit: 20, skipVector: true });

    // With mode=off, fuseDenseTurnLane must not run. Both are [] (no document chunks).
    // If mode were "on", the turn hit "dragon hoards gold" would be injected, making
    // result.searchResults non-empty and NOT equal to the empty directResults.
    expect(result.searchResults).toEqual(directResults);
    // Belt-and-suspenders: both are empty (no document chunks indexed).
    expect(result.searchResults).toHaveLength(0);

    db.close();
  });
});
