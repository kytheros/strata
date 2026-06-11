import { describe, it, expect } from "vitest";
import { deduplicateToSessions, sliceWithKnowledgeSupplement } from "../../src/search/dedupe-to-sessions.js";
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

  it("replaces NaN timestamp on first chunk with a finite timestamp from a later chunk (same session)", () => {
    // First chunk of session has NaN timestamp (e.g. corrupt parse); second chunk has 1000.
    // The merged entry must have timestamp=1000, not NaN.
    const out = deduplicateToSessions([
      r({ sessionId: "s1", timestamp: NaN, text: "a" }),
      r({ sessionId: "s1", timestamp: 1000, text: "b" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].timestamp).toBe(1000);
  });

  it("source-merge guard: knowledge-first then session for same sessionId → merged entry is NOT source:document", () => {
    // A knowledge entry arrives first (source:"document"), then a session entry
    // (source:"conversation") for the same sessionId. After merge the entry must
    // NOT be source:"document" — otherwise sliceWithKnowledgeSupplement would
    // count it against the knowledge cap instead of the session limit (#33).
    const out = deduplicateToSessions([
      r({ sessionId: "shared", source: "document" as const, score: 10 }),
      r({ sessionId: "shared", source: "conversation" as const, score: 1 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].source).not.toBe("document");
  });

  it("source-merge guard: session-first then knowledge for same sessionId → merged entry stays session-class", () => {
    // Session arrives first, knowledge arrives second. The existing entry starts as
    // session-class; the guard must NOT downgrade it to document.
    const out = deduplicateToSessions([
      r({ sessionId: "shared", source: "conversation" as const, score: 1 }),
      r({ sessionId: "shared", source: "document" as const, score: 10 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("conversation");
  });
});

// ---------------------------------------------------------------------------
// sliceWithKnowledgeSupplement
// ---------------------------------------------------------------------------

describe("sliceWithKnowledgeSupplement (#33 fix)", () => {
  function mk(sessionId: string, source: SearchResult["source"], score: number): SearchResult {
    return {
      sessionId, project: "p", text: sessionId, score, confidence: 0.5,
      timestamp: 1, toolNames: [], role: "assistant" as const, source,
    };
  }

  it("exact knowledgeCap boundary: allows exactly knowledgeCap knowledge entries, drops the rest", () => {
    const entries = [
      mk("sess-1", "conversation", 9),
      mk("kn-1", "document", 8),
      mk("kn-2", "document", 7),
      mk("kn-3", "document", 6),
      mk("sess-2", "conversation", 5),
    ];
    // limit=10 (plenty for sessions), knowledgeCap=2 → only kn-1 and kn-2 pass
    const out = sliceWithKnowledgeSupplement(entries, 10, 2);
    expect(out.map(e => e.sessionId)).toEqual(["sess-1", "kn-1", "kn-2", "sess-2"]);
    expect(out.find(e => e.sessionId === "kn-3")).toBeUndefined();
  });

  it("sessions fill limit budget first regardless of interleaved knowledge entries", () => {
    // 5 sessions + 3 knowledge, limit=3, knowledgeCap=3
    // Sessions fill slots 1-3; knowledge entries append after (up to cap)
    const entries = [
      mk("sess-0", "conversation", 10),
      mk("kn-0", "document", 9),
      mk("sess-1", "conversation", 8),
      mk("kn-1", "document", 7),
      mk("sess-2", "conversation", 6),
      mk("kn-2", "document", 5),
      mk("sess-3", "conversation", 4),
      mk("sess-4", "conversation", 3),
    ];
    const out = sliceWithKnowledgeSupplement(entries, 3, 3);
    const sessionIds = out.filter(e => e.source !== "document").map(e => e.sessionId);
    const knowledgeIds = out.filter(e => e.source === "document").map(e => e.sessionId);
    // Exactly 3 sessions, no more
    expect(sessionIds).toHaveLength(3);
    expect(sessionIds).toEqual(["sess-0", "sess-1", "sess-2"]);
    // sess-3 and sess-4 are beyond the limit
    expect(out.find(e => e.sessionId === "sess-3")).toBeUndefined();
    expect(out.find(e => e.sessionId === "sess-4")).toBeUndefined();
    // All 3 knowledge entries pass (within cap)
    expect(knowledgeIds).toHaveLength(3);
  });

  it("source===undefined counts as session-class (not evicted by knowledge cap)", () => {
    // Entries without a source field should count against session slots, not knowledge cap
    const entries = [
      mk("kn-1", "document", 10),
      { sessionId: "no-src", project: "p", text: "x", score: 5,
        confidence: 0.5, timestamp: 1, toolNames: [], role: "assistant" as const } as SearchResult,
    ];
    // limit=1, knowledgeCap=5: the undefined-source entry fills the one session slot
    const out = sliceWithKnowledgeSupplement(entries, 1, 5);
    expect(out.find(e => e.sessionId === "no-src")).toBeDefined();
    expect(out.find(e => e.sessionId === "kn-1")).toBeDefined(); // knowledge within cap
  });

  it("source===turn counts as session-class (not evicted by knowledge cap)", () => {
    const entries = [
      mk("kn-1", "document", 10),
      mk("turn-1", "turn", 9),
      mk("turn-2", "turn", 8),
    ];
    // limit=2, knowledgeCap=1: both turn entries take session slots; kn-1 is within cap
    const out = sliceWithKnowledgeSupplement(entries, 2, 1);
    expect(out.find(e => e.sessionId === "turn-1")).toBeDefined();
    expect(out.find(e => e.sessionId === "turn-2")).toBeDefined();
    expect(out.find(e => e.sessionId === "kn-1")).toBeDefined();
  });
});
