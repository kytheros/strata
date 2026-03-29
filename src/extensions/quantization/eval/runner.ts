/**
 * Frozen quantization eval runner.
 *
 * Combines ranking fidelity and storage metrics into a single pass/fail report.
 * Thresholds are defined once and never modified during optimization.
 *
 * FROZEN EVAL -- DO NOT MODIFY THRESHOLDS DURING QUANTIZATION DEVELOPMENT.
 */

import { evaluateRankingFidelity, type RankingFidelityResult } from "./ranking-fidelity.js";
import { evaluateStorageMetrics, type StorageMetricsResult } from "./storage-metrics.js";
import type { BitWidth } from "../lloyd-max.js";

/** Minimum Spearman's rho for each bit-width to pass */
export const THRESHOLDS: Record<BitWidth, number> = {
  1: 0.85,
  2: 0.95,
  4: 0.99,
  8: 0.999,
} as const;

export interface RankingEvalEntry extends RankingFidelityResult {
  threshold: number;
  pass: boolean;
}

export interface QuantizationEvalResult {
  rankings: RankingEvalEntry[];
  storage: StorageMetricsResult;
  timestamp: number;
  overallPass: boolean;
}

/**
 * Run the full quantization eval suite.
 *
 * @param corpus - Array of Float32 embedding vectors
 * @param queries - Array of query vectors
 * @returns Full eval result with pass/fail per bit-width
 */
export function runQuantizationEval(
  corpus: Float32Array[],
  queries: Float32Array[]
): QuantizationEvalResult {
  const rankings: RankingEvalEntry[] = [];

  for (const bitWidth of [1, 2, 4, 8] as BitWidth[]) {
    const result = evaluateRankingFidelity(corpus, queries, bitWidth);
    const threshold = THRESHOLDS[bitWidth];
    rankings.push({
      ...result,
      threshold,
      pass: result.meanRho >= threshold,
    });
  }

  const storage = evaluateStorageMetrics();

  return {
    rankings,
    storage,
    timestamp: Date.now(),
    overallPass: rankings.every((r) => r.pass),
  };
}
