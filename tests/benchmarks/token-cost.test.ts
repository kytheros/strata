import { describe, it, expect } from "vitest";
import { MODEL_PRICING, computeCost, summariseTokens } from "../../benchmarks/longmemeval/token-cost.js";

describe("token-cost", () => {
  it("has pricing for the bake-off candidates ($/1M in,out)", () => {
    expect(MODEL_PRICING["gemini-2.5-flash"]).toEqual({ inPerM: 0.30, outPerM: 2.50 });
    expect(MODEL_PRICING["gpt-5.4-mini"]).toEqual({ inPerM: 0.75, outPerM: 4.50 });
    expect(MODEL_PRICING["gemini-3-flash"]).toEqual({ inPerM: 0.50, outPerM: 3.00 });
    expect(MODEL_PRICING["claude-haiku-4-5"]).toEqual({ inPerM: 1.00, outPerM: 5.00 });
  });

  it("computes cost from tokens + model", () => {
    // 1M in + 1M out on gemini-2.5-flash = 0.30 + 2.50 = 2.80
    expect(computeCost("gemini-2.5-flash", 1_000_000, 1_000_000)).toBeCloseTo(2.80, 4);
  });

  it("falls back to zero cost for an unknown model (no crash)", () => {
    expect(computeCost("mystery-model", 1000, 1000)).toBe(0);
  });

  it("summarises totals + per-question mean", () => {
    const s = summariseTokens([
      { inputTokens: 100, outputTokens: 10 },
      { inputTokens: 300, outputTokens: 20 },
    ]);
    expect(s.totalInput).toBe(400);
    expect(s.totalOutput).toBe(30);
    expect(s.meanInputPerQ).toBe(200);
  });
});
