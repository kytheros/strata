/**
 * Storage Metrics Eval: measure actual compression ratios at each bit-width.
 */

import { CONFIG } from "../../../config.js";
import { expectedBlobSize } from "../codec.js";
import { quantize } from "../turbo-quant.js";
import type { BitWidth } from "../lloyd-max.js";

export interface BitWidthMetrics {
  bitWidth: BitWidth;
  bytesPerVector: number;
  actualBlobSize: number;
  compressionRatio: number;
}

export interface StorageMetricsResult {
  embeddingDim: number;
  paddedDim: number;
  float32BytesPerVector: number;
  bitWidths: BitWidthMetrics[];
}

/**
 * Evaluate storage metrics for all supported bit-widths.
 * Creates a sample vector and measures actual blob sizes.
 */
export function evaluateStorageMetrics(): StorageMetricsResult {
  const embeddingDim = CONFIG.quantization.embeddingDim;
  const paddedDim = CONFIG.quantization.paddedDim;
  const float32Bytes = embeddingDim * 4;

  // Create a representative unit vector
  const sample = new Float32Array(embeddingDim);
  for (let i = 0; i < embeddingDim; i++) sample[i] = Math.sin(i * 0.01);
  const norm = Math.sqrt(sample.reduce((s, v) => s + v * v, 0));
  for (let i = 0; i < embeddingDim; i++) sample[i] /= norm;

  const bitWidths: BitWidthMetrics[] = [];
  for (const bw of [1, 2, 4, 8] as BitWidth[]) {
    const expected = expectedBlobSize(paddedDim, bw);
    const actualBlob = quantize(sample, bw);
    bitWidths.push({
      bitWidth: bw,
      bytesPerVector: expected,
      actualBlobSize: actualBlob.length,
      compressionRatio: float32Bytes / expected,
    });
  }

  return {
    embeddingDim,
    paddedDim,
    float32BytesPerVector: float32Bytes,
    bitWidths,
  };
}
