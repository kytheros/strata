/**
 * Ranking Fidelity Eval: Spearman's rho between Float32 and quantized rankings.
 *
 * For each query, ranks the corpus by cosine similarity using both raw Float32
 * vectors and quantized-then-dequantized vectors. Compares the two ranked lists
 * using Spearman's rank correlation coefficient.
 *
 * Thresholds (from spec):
 *   4-bit: rho >= 0.99
 *   2-bit: rho >= 0.95
 *   1-bit: rho >= 0.85
 */

import { quantize, dequantize } from "../turbo-quant.js";
import type { BitWidth } from "../lloyd-max.js";

export interface RankingFidelityResult {
  bitWidth: BitWidth;
  meanRho: number;
  minRho: number;
  maxRho: number;
  perQueryRho: number[];
  corpusSize: number;
  queryCount: number;
}

/**
 * Compute Spearman's rank correlation coefficient between two score arrays.
 * Handles ties using average rank assignment.
 */
export function spearmanRho(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length < 2) {
    throw new Error("Arrays must have equal length >= 2");
  }
  const n = a.length;
  const rankA = assignRanks(a);
  const rankB = assignRanks(b);

  // rho = 1 - 6 * sum(d_i^2) / (n * (n^2 - 1))
  let sumD2 = 0;
  for (let i = 0; i < n; i++) {
    const d = rankA[i] - rankB[i];
    sumD2 += d * d;
  }

  return 1 - (6 * sumD2) / (n * (n * n - 1));
}

/** Assign ranks to values (1-based), averaging for ties. */
function assignRanks(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => b.v - a.v); // Descending (highest score = rank 1)

  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j < indexed.length && indexed[j].v === indexed[i].v) j++;
    // Average rank for tied group
    const avgRank = (i + j + 1) / 2; // 1-based: (i+1 + j) / 2
    for (let k = i; k < j; k++) {
      ranks[indexed[k].i] = avgRank;
    }
    i = j;
  }
  return ranks;
}

/** Cosine similarity between two Float32Arrays */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Evaluate ranking fidelity: compare Float32 vs quantized rankings.
 *
 * @param corpus - Array of raw Float32 embedding vectors (3072-dim)
 * @param queries - Array of query vectors to test
 * @param bitWidth - Quantization bit-width to evaluate
 */
export function evaluateRankingFidelity(
  corpus: Float32Array[],
  queries: Float32Array[],
  bitWidth: BitWidth
): RankingFidelityResult {
  // Pre-quantize the corpus
  const quantizedCorpus = corpus.map((vec) => dequantize(quantize(vec, bitWidth)));

  const perQueryRho: number[] = [];

  for (const query of queries) {
    // Score corpus against query using both raw and quantized vectors
    const rawScores = corpus.map((vec) => cosine(query, vec));
    const quantizedScores = quantizedCorpus.map((vec) => cosine(query, vec));

    const rho = spearmanRho(rawScores, quantizedScores);
    perQueryRho.push(rho);
  }

  return {
    bitWidth,
    meanRho: perQueryRho.reduce((s, r) => s + r, 0) / perQueryRho.length,
    minRho: Math.min(...perQueryRho),
    maxRho: Math.max(...perQueryRho),
    perQueryRho,
    corpusSize: corpus.length,
    queryCount: queries.length,
  };
}
