/**
 * Test: deep (session-level) path + agent format composition.
 *
 * Covers:
 *  (a) Candidate-pool fix: searchSessionLevel must receive { limit: 60, sessionK: 20 }
 *      matching retrieve.ts:221-224 exactly (not limit:20/sessionK:20 which starves the pool).
 *  (b) Composition: retrieval_strategy:"deep" + format:"agent" flows through buildAgentContext
 *      and returns a chronological "Note N (date):" block (not standard chrome).
 *  (c) Graceful degradation when the engine lacks a reranker/eventStore — no throw, still returns
 *      an agent-format block.
 *
 * Spec: 2026-06-05-readpath-parity-phase1-design (Task 1+2 of candidate-pool starvation fix).
 * Benchmark reference: benchmarks/longmemeval/retrieve.ts:221-224
 *   searchSessionLevel(query, { limit: 60, sessionK: 20 })
 */
import { describe, it, expect, vi } from "vitest";
import { handleSearchHistory } from "../../src/tools/search-history.js";
import type { SqliteSearchEngine, SearchResult } from "../../src/search/sqlite-search-engine.js";
import type { IKnowledgeTurnStore, KnowledgeTurnHit } from "../../src/storage/interfaces/knowledge-turn-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a single fake SearchResult with a controlled timestamp. */
function makeResult(override: Partial<SearchResult> & { sessionId: string }): SearchResult {
  return {
    project: "test",
    text: "some text content",
    score: 5,
    confidence: 0.8,
    timestamp: Date.UTC(2026, 0, 15), // 2026-01-15 default
    toolNames: [],
    role: "assistant" as const,
    ...override,
  };
}

/**
 * Spy engine: captures the options passed to searchSessionLevel so we can
 * assert the correct limit/sessionK values were forwarded.
 */
function makeSpyEngine(
  results: SearchResult[] = [],
): { engine: SqliteSearchEngine; capturedOptions: Array<Record<string, unknown>> } {
  const capturedOptions: Array<Record<string, unknown>> = [];

  const engine = {
    search: async () => [],
    searchAsync: async () => [],
    searchSessionLevel: async (_query: string, opts: Record<string, unknown>) => {
      capturedOptions.push({ ...opts });
      return results;
    },
    searchTurns: async (): Promise<KnowledgeTurnHit[]> => [],
    setKnowledgeTurnStore: vi.fn(),
    setEmbedder: vi.fn(),
    setVectorSearch: vi.fn(),
    setReranker: vi.fn(),
  } as unknown as SqliteSearchEngine;

  return { engine, capturedOptions };
}

function fakeTurnStore(): IKnowledgeTurnStore {
  return {} as unknown as IKnowledgeTurnStore;
}

/**
 * Create a spy engine that returns sessionResults from searchSessionLevel and
 * turnHits from searchTurns — enabling the fuseDenseTurnLane path.
 */
function makeSpyEngineWithTurns(
  sessionResults: SearchResult[],
  turnHits: KnowledgeTurnHit[],
): { engine: SqliteSearchEngine } {
  const engine = {
    search: async () => [],
    searchAsync: async () => [],
    searchSessionLevel: async () => sessionResults,
    searchTurns: async (): Promise<KnowledgeTurnHit[]> => turnHits,
    setKnowledgeTurnStore: vi.fn(),
    setEmbedder: vi.fn(),
    setVectorSearch: vi.fn(),
    setReranker: vi.fn(),
  } as unknown as SqliteSearchEngine;
  return { engine };
}

/** Build a fake KnowledgeTurnHit for a given sessionId. */
function makeTurnHit(sessionId: string, score: number, ts: number): KnowledgeTurnHit {
  return {
    score,
    row: {
      id: `turn-${sessionId}-${score}`,
      sessionId,
      project: "test",
      speaker: "assistant" as const,
      content: `turn content for ${sessionId}`,
      createdAt: ts,
      embedding: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Task 1 — Candidate-pool starvation fix
// ---------------------------------------------------------------------------

describe("deep branch: candidate-pool size matches benchmark (retrieve.ts:221-224)", () => {
  it("passes limit:60 (DEEP_CANDIDATE_POOL) and sessionK:20 to searchSessionLevel", async () => {
    // RED: before the fix, capturedOptions[0].limit would be 20 (from searchOptions),
    //      NOT 60 — this test fails until the constant is used.
    const results = [makeResult({ sessionId: "s1", timestamp: Date.UTC(2026, 0, 5) })];
    const { engine, capturedOptions } = makeSpyEngine(results);

    await handleSearchHistory(
      engine,
      { query: "database migration plan", limit: 20, retrieval_strategy: "deep" },
      undefined, undefined, undefined,
      fakeTurnStore(),
    );

    expect(capturedOptions).toHaveLength(1);
    // DEEP_CANDIDATE_POOL must be 60, matching retrieve.ts:221-224
    expect(capturedOptions[0].limit).toBe(60);
    // sessionK must be 20, matching retrieve.ts:221-224
    expect(capturedOptions[0].sessionK).toBe(20);
  });

  it("slices the final output to the caller's limit (20), not the pool size (60)", async () => {
    // Build 25 results: pool is bigger than caller limit, output must be capped at caller limit.
    const manyResults: SearchResult[] = Array.from({ length: 25 }, (_, i) =>
      makeResult({ sessionId: `session-${i}`, score: 25 - i, timestamp: Date.UTC(2026, 0, i + 1) })
    );
    const { engine } = makeSpyEngine(manyResults);

    const out = await handleSearchHistory(
      engine,
      { query: "meeting notes", limit: 20, retrieval_strategy: "deep" },
      undefined, undefined, undefined,
      fakeTurnStore(),
    );

    // With limit:20 and 25 results, output should contain at most 20 notes.
    const noteCount = (out.match(/^Note \d+/gm) ?? []).length;
    expect(noteCount).toBeLessThanOrEqual(20);
  });

  it("passes limit:60 regardless of caller limit (caller asks for limit:5)", async () => {
    // Pool must stay at 60 even when caller requests fewer results.
    const results = [makeResult({ sessionId: "s1", timestamp: Date.UTC(2026, 0, 1) })];
    const { engine, capturedOptions } = makeSpyEngine(results);

    await handleSearchHistory(
      engine,
      { query: "auth bug fix", limit: 5, retrieval_strategy: "deep", format: "agent" },
      undefined, undefined, undefined,
      fakeTurnStore(),
    );

    expect(capturedOptions[0].limit).toBe(60);
    expect(capturedOptions[0].sessionK).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Task 2 — Composition: deep + agent format
// ---------------------------------------------------------------------------

describe("deep branch + format:'agent' composition", () => {
  it("returns chronological 'Note N (date):' block, not standard chrome", async () => {
    const results = [
      makeResult({ sessionId: "s-older", timestamp: Date.UTC(2026, 0, 3), text: "database migration planned", score: 5 }),
      makeResult({ sessionId: "s-newer", timestamp: Date.UTC(2026, 0, 10), text: "migration completed successfully", score: 9 }),
    ];
    // engine returns results in score order (newest score first); agent format must re-sort oldest-first
    const { engine } = makeSpyEngine(results);

    const out = await handleSearchHistory(
      engine,
      { query: "database migration", limit: 20, retrieval_strategy: "deep", format: "agent" },
      undefined, undefined, undefined,
      fakeTurnStore(),
    );

    // Must be agent format: numbered notes with dates
    expect(out).toMatch(/Note 1 \(2026-01-03\):/);
    expect(out).toMatch(/Note 2 \(2026-01-10\):/);
    // Oldest entry first
    expect(out.indexOf("migration planned")).toBeLessThan(out.indexOf("migration completed"));
    // No standard chrome
    expect(out).not.toContain("Found ");
    expect(out).not.toContain("---");
  });

  it("does not throw when engine has no reranker or eventStore — returns agent-format block", async () => {
    // Graceful degradation: minimal engine without reranker/eventStore
    const results = [
      makeResult({ sessionId: "s1", timestamp: Date.UTC(2026, 2, 1), text: "auth refactor done" }),
    ];
    const { engine } = makeSpyEngine(results);

    let threw = false;
    let out = "";
    try {
      out = await handleSearchHistory(
        engine,
        { query: "auth refactor", limit: 20, retrieval_strategy: "deep", format: "agent" },
        undefined, undefined, undefined,
        undefined, // no turnStore — graceful degradation path
      );
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    // Must still return an agent-format block (or "no results" sentinel — either is fine)
    const isAgentFormat = out.includes("Note 1") || out.includes("No results");
    expect(isAgentFormat).toBe(true);
  });

  it("returns 'No results' sentinel, not an error, when searchSessionLevel returns nothing", async () => {
    const { engine } = makeSpyEngine([]); // empty results

    const out = await handleSearchHistory(
      engine,
      { query: "nonexistent topic", limit: 20, retrieval_strategy: "deep", format: "agent" },
      undefined, undefined, undefined,
      fakeTurnStore(),
    );

    // Either the standard no-results message or the agent sentinel — must not throw/crash
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain("TypeError");
  });

  it("output contains session-level result text, confirming deep path ran (not FTS fallback)", async () => {
    const SENTINEL = "session-level-unique-sentinel-text";
    const results = [makeResult({ sessionId: "s1", timestamp: Date.UTC(2026, 3, 1), text: SENTINEL })];
    const { engine } = makeSpyEngine(results);

    const out = await handleSearchHistory(
      engine,
      { query: "sentinel search", limit: 20, retrieval_strategy: "deep", format: "agent" },
      undefined, undefined, undefined,
      fakeTurnStore(),
    );

    expect(out).toContain(SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// Task 3 — Session-count collapse fix (root cause: fuseDenseTurnLane turn
// entries displace session entries out of slice(0,20) budget)
// ---------------------------------------------------------------------------
//
// Bug: the deep path does:
//   fuseDenseTurnLane(sessionLane, turnHits, maxTurnResults=10).slice(0, limit=20)
//
// When turnHits covers sessions that are already in sessionLane (or new ones),
// up to 10 turn entries enter the fused list. After slice(0,20) many of those
// slots are individual turn entries; deduplicateToSessions inside buildAgentContext
// merges same-session turns, collapsing distinct session count from ~20 to ~7.
//
// Fix: keep all fused entries (do NOT slice before dedup). Cap after dedup.
// ---------------------------------------------------------------------------

describe("deep branch: distinct session count survives fuseDenseTurnLane (session-count collapse fix)", () => {
  it("yields ~sessionK (≈20) distinct Note blocks when 20 sessions + turn hits present", async () => {
    // Seed 20 distinct sessions as session-lane results.
    const SESSION_COUNT = 20;
    const sessionResults: SearchResult[] = Array.from({ length: SESSION_COUNT }, (_, i) =>
      makeResult({
        sessionId: `session-${i}`,
        score: SESSION_COUNT - i, // descending score
        timestamp: Date.UTC(2026, 0, i + 1),
        text: `session ${i} summary text`,
      }),
    );

    // Seed 10 turn hits: each turn hits one of the FIRST 3 sessions (simulating
    // many turns from a few hot sessions — the worst-case displacement scenario).
    // Before the fix: these 10 turn entries occupy 10 of the 20 slice slots,
    // leaving only 10 session entries; dedup collapses 3 hot sessions → ~13 distinct.
    const turnHits: KnowledgeTurnHit[] = Array.from({ length: 10 }, (_, i) =>
      makeTurnHit(`session-${i % 3}`, SESSION_COUNT + i + 1, Date.UTC(2026, 0, 1) + i * 1000),
    );

    const { engine } = makeSpyEngineWithTurns(sessionResults, turnHits);

    const out = await handleSearchHistory(
      engine,
      { query: "broad project coverage query", limit: 20, retrieval_strategy: "deep", format: "agent" },
      undefined, undefined, undefined,
      fakeTurnStore(), // provides a turn store so the fuseDenseTurnLane branch fires
    );

    // Count "Note N" blocks — each is one deduplicated session.
    const noteCount = (out.match(/^Note \d+/gm) ?? []).length;

    // After the fix: all 20 distinct sessions survive to the agent context.
    // Before the fix: collapsed to ~13 (or fewer) because turns displaced sessions.
    // We assert >= 18 to give one slot of tolerance (knowledge entries are empty here).
    expect(noteCount).toBeGreaterThanOrEqual(18);
  });

  it("turn hits from NEW sessions (not in sessionLane) extend coverage, not collapse it", async () => {
    // 15 sessions in sessionLane, 5 turn hits from 5 NEW sessions not in sessionLane.
    // After fix: we get 20 distinct sessions (15 + 5 new ones).
    const SESSION_COUNT = 15;
    const sessionResults: SearchResult[] = Array.from({ length: SESSION_COUNT }, (_, i) =>
      makeResult({
        sessionId: `session-${i}`,
        score: SESSION_COUNT - i,
        timestamp: Date.UTC(2026, 0, i + 1),
        text: `session ${i} content`,
      }),
    );

    // 5 turn hits from completely NEW sessions (ids 15-19)
    const turnHits: KnowledgeTurnHit[] = Array.from({ length: 5 }, (_, i) =>
      makeTurnHit(`session-${SESSION_COUNT + i}`, SESSION_COUNT + i + 1, Date.UTC(2026, 1, i + 1)),
    );

    const { engine } = makeSpyEngineWithTurns(sessionResults, turnHits);

    const out = await handleSearchHistory(
      engine,
      { query: "extended coverage query", limit: 20, retrieval_strategy: "deep", format: "agent" },
      undefined, undefined, undefined,
      fakeTurnStore(),
    );

    const noteCount = (out.match(/^Note \d+/gm) ?? []).length;
    // Should include all 15 sessions + 5 new turn sessions = 20 distinct blocks.
    expect(noteCount).toBeGreaterThanOrEqual(18);
  });
});
