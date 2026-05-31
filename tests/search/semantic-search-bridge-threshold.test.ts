import { describe, it, expect } from "vitest";
import { SemanticSearchBridge } from "../../src/search/semantic-search-bridge.js";

// Minimal fake engine matching the shape SemanticSearchBridge calls.
function bridgeWithScores(scores: number[]): SemanticSearchBridge {
  const bridge = new SemanticSearchBridge(null as never, null);
  // Inject a fake engine that returns docs with the given scores.
  (bridge as unknown as { engine: unknown }).engine = {
    search: async () =>
      scores.map((s, i) => ({
        docId: `d${i}`,
        text: `result ${i}`,
        score: s,
        project: "p",
        timestamp: 0,
        sessionId: "s",
      })),
  };
  (bridge as unknown as { ensureEngine: () => boolean }).ensureEngine = () => true;
  return bridge;
}

describe("SemanticSearchBridge threshold", () => {
  it("drops results scoring below the threshold", async () => {
    const bridge = bridgeWithScores([0.9, 0.5, 0.2]);
    const results = await bridge.search("q", { threshold: 0.6 });
    expect(results?.map((r) => r.score)).toEqual([0.9]);
  });

  it("returns all results when threshold is omitted", async () => {
    const bridge = bridgeWithScores([0.9, 0.5, 0.2]);
    const results = await bridge.search("q", {});
    expect(results).toHaveLength(3);
  });
});
