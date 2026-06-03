// strata/tests/config/dense-turn-lane-activation.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { CONFIG } from "../../src/config.js";

describe("dense turn-lane activation default", () => {
  afterEach(() => {
    // Clean up env overrides after each test.
    delete process.env.STRATA_DENSE_TURN_LANE;
  });

  it("enabled=true when STRATA_DENSE_TURN_LANE is unset (default ON)", () => {
    delete process.env.STRATA_DENSE_TURN_LANE;
    expect(CONFIG.search.denseTurnLane.enabled).toBe(true);
  });

  it("enabled=false when STRATA_DENSE_TURN_LANE=off (kill-switch)", () => {
    process.env.STRATA_DENSE_TURN_LANE = "off";
    expect(CONFIG.search.denseTurnLane.enabled).toBe(false);
  });

  it("enabled=true when STRATA_DENSE_TURN_LANE=on (explicit opt-in)", () => {
    process.env.STRATA_DENSE_TURN_LANE = "on";
    expect(CONFIG.search.denseTurnLane.enabled).toBe(true);
  });
});
