// strata/tests/config/dense-turn-lane-config.test.ts
import { describe, it, expect } from "vitest";
import { CONFIG } from "../../src/config.js";

describe("dense turn-lane config", () => {
  it("search.denseTurnLane defaults to disabled with conversational task types", () => {
    // STRATA_DENSE_TURN_LANE is unset in the test env → enabled === false.
    expect(CONFIG.search.denseTurnLane.enabled).toBe(false);
    expect(CONFIG.search.denseTurnLane.queryTaskType).toBe("RETRIEVAL_QUERY");
    expect(CONFIG.search.denseTurnLane.docTaskType).toBe("RETRIEVAL_DOCUMENT");
  });

  it("benchmark.denseTurnLane defaults to mode=off", () => {
    expect(CONFIG.benchmark.denseTurnLane.mode).toBe("off");
    expect(CONFIG.benchmark.denseTurnLane.maxTurnResults).toBe(10);
  });
});
