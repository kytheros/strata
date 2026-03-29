import { describe, it, expect } from "vitest";
import { runQuantizationEval, THRESHOLDS } from "../../../src/extensions/quantization/eval/runner.js";

describe("runQuantizationEval", () => {
  it("runs full eval on synthetic corpus and reports pass/fail", () => {
    // Small synthetic corpus for fast testing (real eval uses LongMemEval 500Q)
    const corpus: Float32Array[] = [];
    for (let i = 0; i < 50; i++) {
      const v = new Float32Array(3072);
      for (let j = 0; j < 3072; j++) v[j] = Math.random() - 0.5;
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      for (let j = 0; j < 3072; j++) v[j] /= norm;
      corpus.push(v);
    }

    const queries: Float32Array[] = [];
    for (let i = 0; i < 5; i++) {
      const v = new Float32Array(3072);
      for (let j = 0; j < 3072; j++) v[j] = Math.random() - 0.5;
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      for (let j = 0; j < 3072; j++) v[j] /= norm;
      queries.push(v);
    }

    const result = runQuantizationEval(corpus, queries);

    // Should have results for all bit-widths
    expect(result.rankings).toHaveLength(4);
    expect(result.storage.bitWidths).toHaveLength(4);

    // 4-bit should pass threshold on synthetic data
    const fourBit = result.rankings.find((r) => r.bitWidth === 4)!;
    expect(fourBit.pass).toBe(true);
    expect(fourBit.threshold).toBe(THRESHOLDS[4]);
  }, 60_000);

  it("exports frozen thresholds", () => {
    expect(THRESHOLDS[4]).toBe(0.99);
    expect(THRESHOLDS[2]).toBe(0.95);
    expect(THRESHOLDS[1]).toBe(0.85);
    expect(THRESHOLDS[8]).toBe(0.999);
  });
});
