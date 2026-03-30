/**
 * Latency benchmark: compare search paths at different corpus sizes.
 *
 * Measures wall-clock time for:
 * - Current path (dequantize + cosine)
 * - ADC-only
 * - Two-pass (SDC + ADC)
 *
 * This is an informational benchmark, not a pass/fail gate.
 */

import { describe, it, expect } from "vitest";
import { quantize, dequantize } from "../../../src/extensions/quantization/turbo-quant.js";
import { quantizedSearch, type QuantizedSearchInput } from "../../../src/extensions/quantization/quantized-search.js";
import { CONFIG } from "../../../src/config.js";

function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; magA += a[i]*a[i]; magB += b[i]*b[i]; }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function makeUnitVec(seed: number): Float32Array {
  const vec = new Float32Array(CONFIG.quantization.embeddingDim);
  let s = seed;
  for (let i = 0; i < vec.length; i++) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    vec[i] = ((s >>> 0) / 0xffffffff) - 0.5;
  }
  const norm = Math.sqrt(vec.reduce((a, v) => a + v * v, 0));
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

describe("Latency benchmark", () => {
  // Build synthetic corpora at different sizes
  const sizes = [100, 500, 1000];

  for (const size of sizes) {
    describe(`${size} vectors`, () => {
      const rawVecs: Float32Array[] = [];
      const quantizedInputs: QuantizedSearchInput[] = [];

      // Build corpus (this is slow for large sizes but runs once)
      for (let i = 0; i < size; i++) {
        const vec = makeUnitVec(i + 10000);
        rawVecs.push(vec);
        const blob = quantize(vec, 4);
        quantizedInputs.push({ entryId: `e-${i}`, blob: Buffer.from(blob) });
      }

      const query = makeUnitVec(42);

      it("dequantize + cosine", () => {
        const t0 = performance.now();
        const results: { id: string; score: number }[] = [];
        for (const item of quantizedInputs) {
          const recon = dequantize(item.blob);
          const score = cosineSim(query, recon);
          if (score > 0) results.push({ id: item.entryId, score });
        }
        results.sort((a, b) => b.score - a.score);
        const ms = performance.now() - t0;
        console.log(`  dequantize+cosine (${size}): ${ms.toFixed(1)}ms, ${results.length} results`);
        expect(results.length).toBeGreaterThan(0);
      });

      it("ADC-only", () => {
        const t0 = performance.now();
        const results = quantizedSearch(query, quantizedInputs, 10, 4, 0);
        const ms = performance.now() - t0;
        console.log(`  ADC-only (${size}): ${ms.toFixed(1)}ms, ${results.length} results`);
        expect(results.length).toBeGreaterThan(0);
      });

      it("two-pass SDC+ADC (candidate=50)", () => {
        const t0 = performance.now();
        const results = quantizedSearch(query, quantizedInputs, 10, 4, 50);
        const ms = performance.now() - t0;
        console.log(`  SDC+ADC (${size}, k=50): ${ms.toFixed(1)}ms, ${results.length} results`);
        expect(results.length).toBeGreaterThan(0);
      });
    }, 120_000);
  }
});
