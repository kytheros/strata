import { describe, it, expect } from "vitest";
import { applyTurnRecencyBoost } from "../../src/search/result-ranker.js";
import type { KnowledgeTurnHit } from "../../src/storage/interfaces/knowledge-turn-store.js";

function hit(turnId: string, sessionId: string, createdAt: number, score: number, content = ""): KnowledgeTurnHit {
  return {
    row: {
      turnId, sessionId, project: null, userId: null,
      speaker: "user", content, messageIndex: 0, createdAt,
    },
    score,
  };
}

describe("applyTurnRecencyBoost (session-bucketed recency-dominant)", () => {
  it("returns input unchanged when hits.length < 2", () => {
    const single = [hit("t1", "s1", 1000, 0.5)];
    expect(applyTurnRecencyBoost(single, "what version is the user on now?")).toEqual(single);
    expect(applyTurnRecencyBoost([], "any query")).toEqual([]);
  });

  it("returns input unchanged when all hits share the same session", () => {
    // Distinct createdAt within the session but only one session → no relative
    // recency signal across sessions → no-op.
    const hits = [hit("a", "s1", 1000, 0.5), hit("b", "s1", 1001, 0.4)];
    const out = applyTurnRecencyBoost(hits, "what version is the user on now?", { force: true });
    expect(out.map((h) => h.row.turnId)).toEqual(["a", "b"]);
    expect(out[0].score).toBe(0.5);
    expect(out[1].score).toBe(0.4);
  });

  it("returns input unchanged when all sessions share the same createdAt", () => {
    // Two sessions but their representative createdAt is identical → no-op.
    const hits = [hit("a", "s1", 1000, 0.5), hit("b", "s2", 1000, 0.4)];
    const out = applyTurnRecencyBoost(hits, "what version is the user on now?", { force: true });
    expect(out.map((h) => h.row.turnId)).toEqual(["a", "b"]);
  });

  it("does not fire when classifier doesn't match and force is false", () => {
    const hits = [
      hit("old", "s1", 1000, 0.5, "Node 20"),
      hit("new", "s2", 2000, 0.4, "Node 22"),
    ];
    const out = applyTurnRecencyBoost(hits, "tell me about Node");
    // Classifier didn't fire → return input as-is (no reorder, no score change).
    expect(out.map((h) => h.row.turnId)).toEqual(["old", "new"]);
    expect(out[0].score).toBe(0.5);
    expect(out[1].score).toBe(0.4);
  });

  it("force=true applies reordering regardless of classifier (recency-dominant)", () => {
    const hits = [
      hit("older", "s1", 1000, 0.5, "older content"),
      hit("newer", "s2", 2000, 0.4, "newer content"),
    ];
    const out = applyTurnRecencyBoost(hits, "any query", { force: true });
    // Newer session bucket first. Scores unchanged.
    expect(out.map((h) => h.row.turnId)).toEqual(["newer", "older"]);
    expect(out[0].score).toBe(0.4);
    expect(out[1].score).toBe(0.5);
  });

  it("session-bucketed: BM25 order preserved within each session", () => {
    const hits = [
      hit("oA", "older-session", 1000, 0.5, "older session, high BM25"),
      hit("oB", "older-session", 1001, 0.3, "older session, low BM25"),
      hit("nA", "newer-session", 2000, 0.4, "newer session, high BM25"),
      hit("nB", "newer-session", 2001, 0.1, "newer session, low BM25"),
    ];
    const out = applyTurnRecencyBoost(hits, "any", { force: true });
    // Newer session bucket first (by sessionCreatedAt DESC), BM25 order within.
    expect(out.map((h) => h.row.turnId)).toEqual(["nA", "nB", "oA", "oB"]);
  });

  it("regression guard for 2026-05-19 diagnosis: newer-session wins regardless of BM25 magnitude", () => {
    // Mimics temporal-001's exact failure mode: older turn BM25 ~226,000× higher.
    const hits = [
      hit("older", "s1", 1000, 0.882, "I'm on Node 20 for all Strata repos right now."),
      hit("newer", "s2", 1700604800000, 0.0000039, "Heads up — I bumped Strata to Node 22 last week."),
    ];
    const out = applyTurnRecencyBoost(hits, "What Node version is the user on?");
    // Recency dominance flips order regardless of the ~226,000× BM25 asymmetry.
    expect(out[0].row.turnId).toBe("newer");
    expect(out[1].row.turnId).toBe("older");
  });

  it("does not fire for historical queries even with hasTemporalMarker", () => {
    const hits = [
      hit("old", "s1", 1000, 0.5, "Node 20"),
      hit("new", "s2", 2000, 0.4, "Node 22"),
    ];
    const out = applyTurnRecencyBoost(hits, "What Node version did I see last year?");
    // Historical-marker veto → no reorder.
    expect(out.map((h) => h.row.turnId)).toEqual(["old", "new"]);
  });

  it("stable for ties: sessions with equal createdAt preserve insertion order", () => {
    const hits = [
      hit("first-session-first", "first", 1000, 0.5, "content"),
      hit("second-session-first", "second", 1000, 0.5, "content"),
    ];
    // Both sessions have identical createdAt → distinctCreatedAts size 1 → no-op,
    // so input order is preserved.
    const out = applyTurnRecencyBoost(hits, "any", { force: true });
    expect(out.map((h) => h.row.turnId)).toEqual(["first-session-first", "second-session-first"]);
  });
});
