import { describe, it, expect } from "vitest";
import { evaluateStorageMetrics } from "../../../src/extensions/quantization/eval/storage-metrics.js";

describe("evaluateStorageMetrics", () => {
  it("reports correct sizes and compression ratios", () => {
    const result = evaluateStorageMetrics();

    expect(result.float32BytesPerVector).toBe(12288);
    expect(result.bitWidths).toHaveLength(4);

    // 4-bit
    const four = result.bitWidths.find((b) => b.bitWidth === 4)!;
    expect(four.bytesPerVector).toBe(2052);
    expect(four.compressionRatio).toBeCloseTo(12288 / 2052, 1);

    // 2-bit
    const two = result.bitWidths.find((b) => b.bitWidth === 2)!;
    expect(two.bytesPerVector).toBe(1028);

    // 1-bit
    const one = result.bitWidths.find((b) => b.bitWidth === 1)!;
    expect(one.bytesPerVector).toBe(516);

    // 8-bit
    const eight = result.bitWidths.find((b) => b.bitWidth === 8)!;
    expect(eight.bytesPerVector).toBe(4100);
  });

  it("validates actual blob sizes match expected", () => {
    const result = evaluateStorageMetrics();
    for (const bw of result.bitWidths) {
      expect(bw.actualBlobSize).toBe(bw.bytesPerVector);
    }
  });
});
