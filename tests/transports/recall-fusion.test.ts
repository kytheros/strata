import { describe, it, expect } from "vitest";
import { fuseRecallLanes, type RecallCandidate } from "../../src/transports/recall-fusion.js";

describe("fuseRecallLanes", () => {
  it("fuses two source lists and tags each result with its source", () => {
    const turnHits: RecallCandidate[] = [
      { id: "t1", score: 1.0, source: "turn", content: "moonstone password", tags: [] },
      { id: "t2", score: 0.5, source: "turn", content: "nice weather", tags: ["dialogue"] },
    ];
    const factHits: RecallCandidate[] = [
      { id: "m1", score: 1.0, source: "fact", content: "player told me a password", tags: ["seed"] },
    ];
    const fused = fuseRecallLanes([turnHits, factHits]);
    expect(fused.length).toBe(3);
    const sources = new Set(fused.map(f => f.source));
    expect(sources.has("turn")).toBe(true);
    expect(sources.has("fact")).toBe(true);
  });

  it("preserves rank ordering — higher-RRF item appears first", () => {
    const a: RecallCandidate[] = [{ id: "a", score: 1.0, source: "turn", content: "alpha", tags: [] }];
    const b: RecallCandidate[] = [{ id: "b", score: 1.0, source: "fact", content: "beta", tags: [] }];
    const fused = fuseRecallLanes([a, b]);
    expect(fused.map(f => f.id).sort()).toEqual(["a", "b"]);
  });

  it("returns empty array for two empty input lists", () => {
    expect(fuseRecallLanes([[], []])).toEqual([]);
  });

  it("treats one empty list as source-only fusion", () => {
    const factHits: RecallCandidate[] = [
      { id: "m1", score: 1.0, source: "fact", content: "x", tags: [] },
      { id: "m2", score: 0.5, source: "fact", content: "y", tags: [] },
    ];
    const fused = fuseRecallLanes([[], factHits]);
    expect(fused.length).toBe(2);
    expect(fused[0].id).toBe("m1");
    expect(fused[1].id).toBe("m2");
  });

  it("RRF orders top-of-each-list above mid-of-only-one-list", () => {
    const a: RecallCandidate[] = [
      { id: "a1", score: 3, source: "turn", content: "a1", tags: [] },
      { id: "a2", score: 2, source: "turn", content: "a2", tags: [] },
      { id: "a3", score: 1, source: "turn", content: "a3", tags: [] },
    ];
    const b: RecallCandidate[] = [
      { id: "b1", score: 3, source: "fact", content: "b1", tags: [] },
      { id: "b2", score: 2, source: "fact", content: "b2", tags: [] },
      { id: "b3", score: 1, source: "fact", content: "b3", tags: [] },
    ];
    const fused = fuseRecallLanes([a, b]);
    const topPair = new Set([fused[0].id, fused[1].id]);
    expect(topPair.has("a1") || topPair.has("b1")).toBe(true);
  });
});
