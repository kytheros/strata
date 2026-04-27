import { describe, it, expect } from "vitest";
import { fuseRecallLanes, type RecallCandidate } from "../../src/transports/recall-fusion.js";

describe("fuseRecallLanes", () => {
  it("fuses two source lists and tags each result with its source", () => {
    const turnHits: RecallCandidate[] = [
      { id: "t1", score: 1.0, source: "turn", content: "moonstone password", tags: [], createdAt: 100, speaker: "player" },
      { id: "t2", score: 0.5, source: "turn", content: "nice weather", tags: ["dialogue"], createdAt: 200, speaker: "player" },
    ];
    const factHits: RecallCandidate[] = [
      { id: "m1", score: 1.0, source: "fact", content: "player told me a password", tags: ["seed"], createdAt: 50, speaker: "player" },
    ];
    const fused = fuseRecallLanes([turnHits, factHits]);
    expect(fused.length).toBe(3);
    const sources = new Set(fused.map(f => f.source));
    expect(sources.has("turn")).toBe(true);
    expect(sources.has("fact")).toBe(true);
  });

  it("preserves rank ordering — higher-RRF item appears first", () => {
    const a: RecallCandidate[] = [{ id: "a", score: 1.0, source: "turn", content: "alpha", tags: [], createdAt: 100, speaker: "player" }];
    const b: RecallCandidate[] = [{ id: "b", score: 1.0, source: "fact", content: "beta", tags: [], createdAt: 200, speaker: "player" }];
    const fused = fuseRecallLanes([a, b]);
    expect(fused.map(f => f.id).sort()).toEqual(["a", "b"]);
  });

  it("returns empty array for two empty input lists", () => {
    expect(fuseRecallLanes([[], []])).toEqual([]);
  });

  it("treats one empty list as source-only fusion", () => {
    const factHits: RecallCandidate[] = [
      { id: "m1", score: 1.0, source: "fact", content: "x", tags: [], createdAt: 100, speaker: "player" },
      { id: "m2", score: 0.5, source: "fact", content: "y", tags: [], createdAt: 200, speaker: "player" },
    ];
    const fused = fuseRecallLanes([[], factHits]);
    expect(fused.length).toBe(2);
    expect(fused[0].id).toBe("m1");
    expect(fused[1].id).toBe("m2");
  });

  it("RRF orders top-of-each-list above mid-of-only-one-list", () => {
    const a: RecallCandidate[] = [
      { id: "a1", score: 3, source: "turn", content: "a1", tags: [], createdAt: 100, speaker: "player" },
      { id: "a2", score: 2, source: "turn", content: "a2", tags: [], createdAt: 200, speaker: "player" },
      { id: "a3", score: 1, source: "turn", content: "a3", tags: [], createdAt: 300, speaker: "player" },
    ];
    const b: RecallCandidate[] = [
      { id: "b1", score: 3, source: "fact", content: "b1", tags: [], createdAt: 400, speaker: "player" },
      { id: "b2", score: 2, source: "fact", content: "b2", tags: [], createdAt: 500, speaker: "player" },
      { id: "b3", score: 1, source: "fact", content: "b3", tags: [], createdAt: 600, speaker: "player" },
    ];
    const fused = fuseRecallLanes([a, b]);
    const topPair = new Set([fused[0].id, fused[1].id]);
    expect(topPair.has("a1") || topPair.has("b1")).toBe(true);
  });

  it("preserves createdAt and speaker on fused candidates", () => {
    const turnHits: RecallCandidate[] = [
      { id: "t1", score: 1.0, source: "turn", content: "I am Goran", tags: [], createdAt: 1000, speaker: "npc" },
      { id: "t2", score: 0.5, source: "turn", content: "the password is moonstone", tags: [], createdAt: 2000, speaker: "player" },
    ];
    const fused = fuseRecallLanes([turnHits]);
    expect(fused.length).toBe(2);
    const t1 = fused.find(f => f.id === "t1")!;
    const t2 = fused.find(f => f.id === "t2")!;
    expect(t1.createdAt).toBe(1000);
    expect(t1.speaker).toBe("npc");
    expect(t2.createdAt).toBe(2000);
    expect(t2.speaker).toBe("player");
  });
});
