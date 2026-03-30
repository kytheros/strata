/**
 * Quantized-domain search: direct similarity on packed indices.
 *
 * Two-pass pipeline:
 *   Pass 1 (SDC): approximate dot product via index-to-index table lookup
 *   Pass 2 (ADC): precise dot product via query-float x centroid lookup
 *
 * Reference: TurboQuant (Zandieh et al., 2025), specs/2026-03-29-quantized-domain-search-design.md
 */

import { CONFIG } from "../../config.js";
import { hadamardTransform, zeroPad } from "./hadamard.js";
import { getCodebook, quantizeScalar, type BitWidth } from "./lloyd-max.js";
import { decodeBlob, unpackIndices } from "./codec.js";

const PADDED_DIM = CONFIG.quantization.paddedDim;

/**
 * Prepare a query vector for quantized-domain search.
 * Zero-pads to paddedDim and applies Hadamard rotation.
 * The returned vector is in the rotated domain — same space as stored indices.
 */
export function prepareRotatedQuery(queryVec: Float32Array): Float32Array {
  const padded = zeroPad(queryVec, PADDED_DIM);
  // zeroPad returns the same array if already correct size, so copy to avoid mutation
  const rotated = padded === queryVec ? Float32Array.from(padded) : padded;
  hadamardTransform(rotated);
  return rotated;
}

/**
 * Asymmetric Distance Computation (ADC).
 *
 * Computes the inner product between a Float32 rotated query and a
 * quantized stored vector (represented as centroid indices).
 *
 * dot = sum_j(rotatedQuery[j] * centroids[indices[j]])
 *
 * This equals the inner product in the original domain because
 * Hadamard preserves inner products: <Hx, Hy> = <x, y>.
 *
 * @param rotatedQuery - Query vector in Hadamard-rotated domain (Float32, paddedDim)
 * @param indices - Quantized coordinate indices of stored vector (Uint8Array, paddedDim)
 * @param centroids - Codebook centroid values (Float64Array, 2^bitWidth entries)
 * @returns Inner product (approximate cosine similarity for unit vectors)
 */
export function adcDotProduct(
  rotatedQuery: Float32Array,
  indices: Uint8Array,
  centroids: Float64Array
): number {
  let dot = 0;
  for (let j = 0; j < PADDED_DIM; j++) {
    dot += rotatedQuery[j] * centroids[indices[j]];
  }
  return dot;
}

/**
 * Quantize a rotated query vector to centroid indices for SDC.
 * Reuses the same quantizeScalar from Lloyd-Max.
 */
export function quantizeQueryIndices(
  rotatedQuery: Float32Array,
  codebook: ReturnType<typeof getCodebook>
): Uint8Array {
  const indices = new Uint8Array(PADDED_DIM);
  for (let j = 0; j < PADDED_DIM; j++) {
    indices[j] = quantizeScalar(rotatedQuery[j], codebook);
  }
  return indices;
}

/**
 * Build the SDC lookup table: sdc[i][j] = centroid[i] * centroid[j].
 * At 4-bit, this is a 16x16 matrix (256 entries). Computed once per query.
 */
export function buildSdcTable(centroids: Float64Array): Float64Array[] {
  const numLevels = centroids.length;
  const table: Float64Array[] = new Array(numLevels);
  for (let i = 0; i < numLevels; i++) {
    table[i] = new Float64Array(numLevels);
    for (let j = 0; j < numLevels; j++) {
      table[i][j] = centroids[i] * centroids[j];
    }
  }
  return table;
}

/**
 * Symmetric Distance Computation (SDC).
 *
 * Approximate dot product using only index-to-index table lookups.
 * Both query and stored vector are represented as centroid indices.
 * No float multiplication — just indexed reads and addition.
 *
 * @param queryIndices - Quantized query coordinate indices (Uint8Array, paddedDim)
 * @param storedIndices - Quantized stored vector indices (Uint8Array, paddedDim)
 * @param sdcTable - Precomputed centroid[i]*centroid[j] table
 * @returns Approximate inner product
 */
export function sdcDotProduct(
  queryIndices: Uint8Array,
  storedIndices: Uint8Array,
  sdcTable: Float64Array[]
): number {
  let dot = 0;
  for (let j = 0; j < PADDED_DIM; j++) {
    dot += sdcTable[queryIndices[j]][storedIndices[j]];
  }
  return dot;
}

/** Input format for quantized search */
export interface QuantizedSearchInput {
  entryId: string;
  blob: Buffer | Uint8Array;
}

/** Search result */
export interface QuantizedSearchResult {
  entryId: string;
  score: number;
}

/**
 * Quantized-domain search: two-pass SDC pre-filter + ADC re-score.
 *
 * @param queryVec - Raw query vector (Float32, 3072-dim) from Gemini API
 * @param corpus - Array of quantized BLOBs with entry IDs
 * @param limit - Maximum results to return
 * @param bitWidth - Quantization bit-width (must match stored vectors)
 * @param candidateCount - SDC candidate count override (0 = ADC-only). Defaults to CONFIG value.
 * @returns Sorted results with cosine similarity scores
 */
export function quantizedSearch(
  queryVec: Float32Array,
  corpus: QuantizedSearchInput[],
  limit: number,
  bitWidth: BitWidth,
  candidateCount?: number
): QuantizedSearchResult[] {
  if (corpus.length === 0) return [];

  const codebook = getCodebook(bitWidth);
  const candidates = candidateCount ?? CONFIG.search.quantizedCandidateCount;
  const sdcThreshold = CONFIG.search.quantizedSdcThreshold;

  // Step 1: Rotate query into Hadamard domain (once)
  const rotatedQuery = prepareRotatedQuery(queryVec);

  // Step 2: Unpack all indices (reused across both passes)
  const unpacked: { entryId: string; indices: Uint8Array }[] = [];
  for (const item of corpus) {
    const bytes = item.blob instanceof Uint8Array ? item.blob : new Uint8Array(item.blob.buffer, item.blob.byteOffset, item.blob.byteLength);
    const { header, payload } = decodeBlob(bytes);
    const indices = unpackIndices(payload, header.bitWidth, PADDED_DIM);
    unpacked.push({ entryId: item.entryId, indices });
  }

  let scoredResults: QuantizedSearchResult[];

  // Decide path: SDC pre-filter + ADC, or ADC-only
  const useSdc = candidates > 0 && corpus.length > sdcThreshold;

  if (useSdc) {
    // Pass 1: SDC pre-filter
    const queryIndices = quantizeQueryIndices(rotatedQuery, codebook);
    const sdcTable = buildSdcTable(codebook.centroids);

    const sdcScores: { idx: number; score: number }[] = [];
    for (let i = 0; i < unpacked.length; i++) {
      const score = sdcDotProduct(queryIndices, unpacked[i].indices, sdcTable);
      sdcScores.push({ idx: i, score });
    }

    // Keep top candidates
    sdcScores.sort((a, b) => b.score - a.score);
    const topCandidates = sdcScores.slice(0, candidates);

    // Pass 2: ADC re-score on candidates only
    scoredResults = topCandidates.map((c) => ({
      entryId: unpacked[c.idx].entryId,
      score: adcDotProduct(rotatedQuery, unpacked[c.idx].indices, codebook.centroids),
    }));
  } else {
    // ADC-only: score all vectors precisely
    scoredResults = unpacked.map((item) => ({
      entryId: item.entryId,
      score: adcDotProduct(rotatedQuery, item.indices, codebook.centroids),
    }));
  }

  // Filter negative scores and sort descending
  scoredResults = scoredResults.filter((r) => r.score > 0);
  scoredResults.sort((a, b) => b.score - a.score);

  return scoredResults.slice(0, limit);
}
