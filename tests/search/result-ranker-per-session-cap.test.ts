import { describe, it, expect } from "vitest";
import { applyPerSessionCap } from "../../src/search/result-ranker.js";
import type { KnowledgeTurnHit } from "../../src/storage/interfaces/knowledge-turn-store.js";

function hit(
  turnId: string,
  sessionId: string,
  speaker: "user" | "assistant" | "system",
  messageIndex: number,
  score: number,
): KnowledgeTurnHit {
  return {
    row: { turnId, sessionId, project: null, userId: null, speaker, content: "", messageIndex, createdAt: 1000 },
    score,
  };
}

describe("applyPerSessionCap", () => {
  it("returns empty input unchanged", () => {
    expect(applyPerSessionCap([])).toEqual([]);
  });

  it("returns single hit unchanged", () => {
    const single = [hit("a", "s1", "user", 0, 0.9)];
    expect(applyPerSessionCap(single)).toEqual(single);
  });

  it("returns input unchanged when one session has count ≤ cap", () => {
    // 2 hits in one session, exactly at cap=2.
    const hits = [
      hit("a", "s1", "user", 0, 0.9),
      hit("b", "s1", "user", 1, 0.8),
    ];
    expect(applyPerSessionCap(hits).map((h) => h.row.turnId)).toEqual(["a", "b"]);
  });

  it("demotes over-cap hits from single session to end (single-session edge case)", () => {
    // 5 hits in one session, cap=2 → keep first 2, demote last 3 to end (in same relative order).
    // Single session: kept=[a,b]; overflow=[c,d,e]; concat [a,b,c,d,e] — no observable change.
    const hits = [
      hit("a", "s1", "user", 0, 0.9),
      hit("b", "s1", "user", 1, 0.8),
      hit("c", "s1", "user", 2, 0.7),
      hit("d", "s1", "user", 3, 0.6),
      hit("e", "s1", "user", 4, 0.5),
    ];
    expect(applyPerSessionCap(hits).map((h) => h.row.turnId)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("returns input unchanged when two sessions are each ≤ cap", () => {
    // s1 has 2 hits, s2 has 2 hits — each exactly at cap=2. No overflow.
    const hits = [
      hit("a", "s1", "user", 0, 0.9),
      hit("b", "s2", "user", 0, 0.8),
      hit("c", "s1", "user", 1, 0.7),
      hit("d", "s2", "user", 1, 0.6),
    ];
    expect(applyPerSessionCap(hits).map((h) => h.row.turnId)).toEqual(["a", "b", "c", "d"]);
  });

  it("demotes over-cap session's excess and frees slots for under-cap session (ranking-004 pattern)", () => {
    // Session A has 6 hits, session B has 2 hits. Cap=2.
    // Pre: [A0,A1,A2,A3,A4,A5,B0,B1]
    // Walk: A0(A=1,keep), A1(A=2,keep), A2(A=3,overflow), A3(A=4,overflow),
    //       A4(A=5,overflow), A5(A=6,overflow), B0(B=1,keep), B1(B=2,keep)
    // Result: kept=[A0,A1,B0,B1] + overflow=[A2,A3,A4,A5]
    const hits = [
      hit("A0", "A", "user", 0, 0.9),
      hit("A1", "A", "user", 1, 0.8),
      hit("A2", "A", "user", 2, 0.7),
      hit("A3", "A", "user", 3, 0.6),
      hit("A4", "A", "user", 4, 0.5),
      hit("A5", "A", "user", 5, 0.4),
      hit("B0", "B", "user", 0, 0.3),
      hit("B1", "B", "user", 1, 0.2),
    ];
    expect(applyPerSessionCap(hits).map((h) => h.row.turnId)).toEqual(["A0", "A1", "B0", "B1", "A2", "A3", "A4", "A5"]);
  });

  it("handles three sessions with one over the cap", () => {
    // A has 4, B has 1, C has 1. Cap=2.
    const hits = [
      hit("A0", "A", "user", 0, 0.9),
      hit("B0", "B", "user", 0, 0.85),
      hit("A1", "A", "user", 1, 0.8),
      hit("C0", "C", "user", 0, 0.75),
      hit("A2", "A", "user", 2, 0.7),
      hit("A3", "A", "user", 3, 0.6),
    ];
    // Walk: A0(A=1,keep), B0(B=1,keep), A1(A=2,keep), C0(C=1,keep), A2(A=3,overflow), A3(A=4,overflow)
    // kept=[A0,B0,A1,C0] + overflow=[A2,A3]
    expect(applyPerSessionCap(hits).map((h) => h.row.turnId)).toEqual(["A0", "B0", "A1", "C0", "A2", "A3"]);
  });

  it("preserves rank-1 from input (top-1 preservation property)", () => {
    // Property-style check: for any input, hits[0] equals output[0].
    const hits = [
      hit("first", "A", "user", 0, 0.9),
      hit("x", "A", "user", 1, 0.8),
      hit("y", "A", "user", 2, 0.7),
      hit("z", "A", "user", 3, 0.6),
      hit("w", "A", "user", 4, 0.5),
    ];
    expect(applyPerSessionCap(hits)[0]).toBe(hits[0]);
  });

  it("preserves within-session order in both kept and overflow", () => {
    // Session A overflow goes [A2, A3, A4, A5] in input order. Confirm relative order maintained.
    // Cap=2: kept=[A0,A1], overflow=[A2,A3,A4,A5]. Single session → concat is same as input order.
    const hits = [
      hit("A0", "A", "user", 0, 0.9),
      hit("A1", "A", "user", 1, 0.8),
      hit("A2", "A", "user", 2, 0.7),
      hit("A3", "A", "user", 3, 0.6),
      hit("A4", "A", "user", 4, 0.5),
      hit("A5", "A", "user", 5, 0.4),
    ];
    const out = applyPerSessionCap(hits).map((h) => h.row.turnId);
    // Within kept: A0,A1 in original order. Within overflow: A2,A3,A4,A5 in original order.
    expect(out).toEqual(["A0", "A1", "A2", "A3", "A4", "A5"]);
  });
});
