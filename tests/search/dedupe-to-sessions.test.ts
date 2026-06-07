import { describe, it, expect } from "vitest";
import { deduplicateToSessions } from "../../src/search/dedupe-to-sessions.js";
import type { SearchResult } from "../../src/search/sqlite-search-engine.js";

function r(over: Partial<SearchResult>): SearchResult {
  return {
    sessionId: "s1", project: "p", text: "t", score: 1, confidence: 1,
    timestamp: 1000, toolNames: [], role: "mixed", ...over,
  };
}

describe("deduplicateToSessions", () => {
  it("merges results sharing a sessionId, concatenating text and keeping best score", () => {
    const out = deduplicateToSessions([
      r({ sessionId: "s1", text: "a", score: 0.4, timestamp: 2000 }),
      r({ sessionId: "s1", text: "b", score: 0.9, timestamp: 1000 }),
      r({ sessionId: "s2", text: "c", score: 0.5, timestamp: 3000 }),
    ]);
    expect(out).toHaveLength(2);
    const s1 = out.find((x) => x.sessionId === "s1")!;
    expect(s1.text).toBe("a\n\nb");
    expect(s1.score).toBe(0.9);          // best score kept
    expect(s1.timestamp).toBe(1000);     // earliest timestamp kept
  });

  it("returns results sorted by score descending", () => {
    const out = deduplicateToSessions([
      r({ sessionId: "lo", score: 0.2 }),
      r({ sessionId: "hi", score: 0.8 }),
    ]);
    expect(out.map((x) => x.sessionId)).toEqual(["hi", "lo"]);
  });
});
