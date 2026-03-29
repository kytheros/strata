import { describe, it, expect } from "vitest";
import { spearmanRho, evaluateRankingFidelity } from "../../../src/extensions/quantization/eval/ranking-fidelity.js";

describe("spearmanRho", () => {
  it("returns 1.0 for identical rankings", () => {
    expect(spearmanRho([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])).toBeCloseTo(1.0, 5);
  });

  it("returns -1.0 for reversed rankings", () => {
    expect(spearmanRho([1, 2, 3, 4, 5], [5, 4, 3, 2, 1])).toBeCloseTo(-1.0, 5);
  });

  it("returns ~0 for uncorrelated rankings", () => {
    // This is approximate -- not perfectly 0 for finite samples
    const rho = spearmanRho([1, 2, 3, 4, 5, 6], [2, 5, 1, 6, 3, 4]);
    expect(Math.abs(rho)).toBeLessThan(0.5);
  });

  it("handles tied ranks", () => {
    const rho = spearmanRho([1, 2, 2, 4], [1, 3, 2, 4]);
    expect(rho).toBeGreaterThan(0.5);
    expect(rho).toBeLessThanOrEqual(1.0);
  });
});

describe("evaluateRankingFidelity", () => {
  it("returns high rho for synthetic 4-bit quantization", () => {
    // Generate synthetic corpus: 100 random 3072-dim unit vectors
    const corpus: Float32Array[] = [];
    for (let i = 0; i < 100; i++) {
      const v = new Float32Array(3072);
      for (let j = 0; j < 3072; j++) v[j] = Math.random() - 0.5;
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      for (let j = 0; j < 3072; j++) v[j] /= norm;
      corpus.push(v);
    }

    // Generate 10 query vectors
    const queries: Float32Array[] = [];
    for (let i = 0; i < 10; i++) {
      const v = new Float32Array(3072);
      for (let j = 0; j < 3072; j++) v[j] = Math.random() - 0.5;
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      for (let j = 0; j < 3072; j++) v[j] /= norm;
      queries.push(v);
    }

    const result = evaluateRankingFidelity(corpus, queries, 4);
    expect(result.meanRho).toBeGreaterThan(0.95);
    expect(result.minRho).toBeGreaterThan(0.85);
    expect(result.bitWidth).toBe(4);
  }, 30_000); // Allow 30s for large computation
});
