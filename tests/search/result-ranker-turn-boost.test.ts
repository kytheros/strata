import { describe, it, expect } from "vitest";
import { applyTurnRecencyBoost } from "../../src/search/result-ranker.js";
import type { KnowledgeTurnHit } from "../../src/storage/interfaces/knowledge-turn-store.js";

function hit(turnId: string, createdAt: number, score: number, content = ""): KnowledgeTurnHit {
  return {
    row: {
      turnId, sessionId: "s", project: null, userId: null,
      speaker: "user", content, messageIndex: 0, createdAt,
    },
    score,
  };
}

describe("applyTurnRecencyBoost", () => {
  it("returns input unchanged when hits.length < 2", () => {
    const single = [hit("t1", 1000, 0.5)];
    expect(applyTurnRecencyBoost(single, "what version is the user on now?")).toEqual(single);
    expect(applyTurnRecencyBoost([], "any query")).toEqual([]);
  });

  it("returns input unchanged when all createdAt are equal", () => {
    const hits = [hit("a", 1000, 0.5), hit("b", 1000, 0.4)];
    const out = applyTurnRecencyBoost(hits, "what version is the user on now?");
    // No relative recency signal -> no reordering, no score change
    expect(out.map((h) => h.row.turnId)).toEqual(["a", "b"]);
    expect(out[0].score).toBe(0.5);
    expect(out[1].score).toBe(0.4);
  });

  it("does not fire when classifier doesn't match and force is false", () => {
    const hits = [
      hit("old", 1000, 0.5, "Node 20"),
      hit("new", 2000, 0.4, "Node 22"),
    ];
    const out = applyTurnRecencyBoost(hits, "tell me about Node");
    // No boost -> sorted by raw score (descending). "old" wins because it has higher score.
    expect(out.map((h) => h.row.turnId)).toEqual(["old", "new"]);
  });

  it("force=true applies boost regardless of classifier", () => {
    const hits = [
      hit("old", 1000, 0.5, "Node 20"),
      hit("new", 2000, 0.4, "Node 22"),
    ];
    const out = applyTurnRecencyBoost(hits, "any query", { force: true });
    // Newest gets 1+boostMax (default 0.5) -> 0.4 * 1.5 = 0.6. Oldest unchanged at 0.5.
    expect(out.map((h) => h.row.turnId)).toEqual(["new", "old"]);
    expect(out[0].score).toBeCloseTo(0.6, 5);
    expect(out[1].score).toBeCloseTo(0.5, 5);
  });

  it("fires when classifier matches", () => {
    const hits = [
      hit("old", 1000, 0.5, "Node 20"),
      hit("new", 2000, 0.4, "Node 22"),
    ];
    const out = applyTurnRecencyBoost(hits, "What Node version is the user on now?");
    expect(out.map((h) => h.row.turnId)).toEqual(["new", "old"]);
  });

  it("does not fire for historical queries even with hasTemporalMarker", () => {
    const hits = [
      hit("old", 1000, 0.5, "Node 20"),
      hit("new", 2000, 0.4, "Node 22"),
    ];
    const out = applyTurnRecencyBoost(hits, "What Node version did I see last year?");
    expect(out.map((h) => h.row.turnId)).toEqual(["old", "new"]);
  });

  it("linear interpolation between oldest (1.0x) and newest (1+boostMax)", () => {
    // Three hits at 1000, 1500, 2000 with identical scores 1.0.
    // boostMax = 0.5. Multipliers: 1.0, 1.25, 1.5. Order: newest (2000), middle (1500), oldest (1000).
    const hits = [
      hit("middle", 1500, 1.0),
      hit("old", 1000, 1.0),
      hit("new", 2000, 1.0),
    ];
    const out = applyTurnRecencyBoost(hits, "any", { force: true, boostMax: 0.5 });
    expect(out.map((h) => h.row.turnId)).toEqual(["new", "middle", "old"]);
    expect(out[0].score).toBeCloseTo(1.5, 5);
    expect(out[1].score).toBeCloseTo(1.25, 5);
    expect(out[2].score).toBeCloseTo(1.0, 5);
  });

  it("stable for ties: equal boosted scores preserve input order", () => {
    // Two hits with identical createdAt and identical scores -> both multipliers equal.
    // No reordering should happen; input order preserved.
    const hits = [hit("first", 1000, 0.5), hit("second", 1000, 0.5)];
    const out = applyTurnRecencyBoost(hits, "any", { force: true });
    expect(out.map((h) => h.row.turnId)).toEqual(["first", "second"]);
  });
});
