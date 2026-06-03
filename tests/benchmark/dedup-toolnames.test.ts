// strata/tests/benchmark/dedup-toolnames.test.ts
/**
 * Regression test for FIX 1: deduplicateToSessions crashes when the SECOND
 * result of a session has toolNames === undefined.
 *
 * Root cause: dense-turn fusion reorders results so an undefined-toolNames
 * chunk is no longer first-of-session, hitting the `for (const t of r.toolNames)`
 * loop which throws TypeError: r.toolNames is not iterable.
 *
 * The fix makes toolNames access defensive in both the first-insert spread and
 * the merge-loop: use `r.toolNames ?? []`.
 */
import { describe, it, expect } from "vitest";
import { deduplicateToSessions } from "../../benchmarks/longmemeval/answer.js";
import type { SearchResult } from "../../src/search/sqlite-search-engine.js";

function makeResult(overrides: Partial<SearchResult> & { sessionId: string; score: number; text: string }): SearchResult {
  return {
    project: "p",
    confidence: 1,
    timestamp: 1000,
    toolNames: [],
    role: "mixed",
    source: "conversation",
    ...overrides,
  };
}

describe("deduplicateToSessions — toolNames undefined guard (FIX 1)", () => {
  it("does NOT throw when the SECOND result of a session has toolNames:undefined", () => {
    // Simulates the ON-arm crash: dense-turn fusion reordered results so the
    // second-of-session result has undefined toolNames (chunk from searchSessionLevel).
    const results: SearchResult[] = [
      makeResult({ sessionId: "sA", score: 2, text: "first of session A", toolNames: ["tool-x"] }),
      // This one has no toolNames — the crash case.
      makeResult({ sessionId: "sA", score: 1, text: "second of session A", toolNames: undefined as unknown as string[] }),
    ];
    expect(() => deduplicateToSessions(results)).not.toThrow();
    const deduped = deduplicateToSessions(results);
    expect(deduped).toHaveLength(1); // collapsed to single session
    expect(deduped[0].sessionId).toBe("sA");
    // tool names from the non-undefined side must be retained
    expect(deduped[0].toolNames).toContain("tool-x");
  });

  it("does NOT throw when the FIRST result of a session has toolNames:undefined", () => {
    const results: SearchResult[] = [
      // First-of-session: undefined toolNames spreads into the session map entry.
      // Later merge of a second result must not crash iterating existing.toolNames.
      makeResult({ sessionId: "sB", score: 3, text: "first of session B", toolNames: undefined as unknown as string[] }),
      makeResult({ sessionId: "sB", score: 1, text: "second of session B", toolNames: ["tool-y"] }),
    ];
    expect(() => deduplicateToSessions(results)).not.toThrow();
    const deduped = deduplicateToSessions(results);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].toolNames).toContain("tool-y");
  });

  it("merges toolNames correctly when both results have defined toolNames", () => {
    const results: SearchResult[] = [
      makeResult({ sessionId: "sC", score: 5, text: "first", toolNames: ["a", "b"] }),
      makeResult({ sessionId: "sC", score: 3, text: "second", toolNames: ["b", "c"] }),
    ];
    const deduped = deduplicateToSessions(results);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].toolNames.sort()).toEqual(["a", "b", "c"]);
  });
});
