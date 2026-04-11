/**
 * Ranking fidelity eval on REAL Gemini embeddings from production database.
 * Validates that quantization preserves search ranking order on actual data.
 */

import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";
import { quantize, dequantize } from "../../../src/extensions/quantization/turbo-quant.js";
import { spearmanRho } from "../../../src/extensions/quantization/eval/ranking-fidelity.js";
import type { BitWidth } from "../../../src/extensions/quantization/lloyd-max.js";

function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

const dbPath = join(homedir(), ".strata", "strata.db");
const hasDb = existsSync(dbPath);

describe.skipIf(!hasDb)("Ranking fidelity on real Gemini embeddings", () => {
  let corpus: Float32Array[] = [];
  let queries: Float32Array[] = [];

  beforeAll(() => {
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT embedding FROM embeddings").all() as { embedding: Buffer }[];
    db.close();

    if (rows.length === 0) {
      console.log("Skipping: no embeddings found in database");
      return;
    }

    // Filter to only 3072-dim vectors (Gemini text-embedding-004).
    // Older models (e.g., text-embedding-preview-0409) produced 768-dim or 513-dim.
    // The DB may contain a mix if the user upgraded models over time.
    const allVectors = rows.map((r) => {
      const buf = r.embedding;
      return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    });

    corpus = allVectors.filter((v) => v.length === 3072);

    if (corpus.length === 0) {
      const dims = [...new Set(allVectors.map((v) => v.length))];
      console.log(`Skipping: no 3072-dim vectors found (dimensions present: ${dims.join(", ")})`);
      return;
    }

    // Use first 15 vectors as queries
    queries = corpus.slice(0, Math.min(15, corpus.length));
    console.log(`Loaded ${corpus.length} real embeddings (of ${allVectors.length} total), using ${queries.length} as queries`);
  });

  it("4-bit: rho >= 0.99", () => {
    if (corpus.length === 0) return; // Skipped in beforeAll due to dimension mismatch
    const rhos = evalBitWidth(corpus, queries, 4);
    const mean = rhos.reduce((s, r) => s + r, 0) / rhos.length;
    console.log(`4-bit: mean_rho=${mean.toFixed(6)} min=${Math.min(...rhos).toFixed(6)} max=${Math.max(...rhos).toFixed(6)}`);
    expect(mean).toBeGreaterThanOrEqual(0.99);
  }, 120_000);

  it("2-bit: rho >= 0.95", () => {
    if (corpus.length === 0) return; // Skipped in beforeAll due to dimension mismatch
    const rhos = evalBitWidth(corpus, queries, 2);
    const mean = rhos.reduce((s, r) => s + r, 0) / rhos.length;
    console.log(`2-bit: mean_rho=${mean.toFixed(6)} min=${Math.min(...rhos).toFixed(6)} max=${Math.max(...rhos).toFixed(6)}`);
    expect(mean).toBeGreaterThanOrEqual(0.95);
  }, 120_000);

  it("1-bit: rho >= 0.85", () => {
    if (corpus.length === 0) return; // Skipped in beforeAll due to dimension mismatch
    const rhos = evalBitWidth(corpus, queries, 1);
    const mean = rhos.reduce((s, r) => s + r, 0) / rhos.length;
    console.log(`1-bit: mean_rho=${mean.toFixed(6)} min=${Math.min(...rhos).toFixed(6)} max=${Math.max(...rhos).toFixed(6)}`);
    expect(mean).toBeGreaterThanOrEqual(0.85);
  }, 120_000);

  it("8-bit: rho >= 0.999", () => {
    if (corpus.length === 0) return; // Skipped in beforeAll due to dimension mismatch
    const rhos = evalBitWidth(corpus, queries, 8);
    const mean = rhos.reduce((s, r) => s + r, 0) / rhos.length;
    console.log(`8-bit: mean_rho=${mean.toFixed(6)} min=${Math.min(...rhos).toFixed(6)} max=${Math.max(...rhos).toFixed(6)}`);
    expect(mean).toBeGreaterThanOrEqual(0.999);
  }, 120_000);
});

function evalBitWidth(corpus: Float32Array[], queries: Float32Array[], bits: BitWidth): number[] {
  const quantizedCorpus = corpus.map((vec) => dequantize(quantize(vec, bits)));
  const rhos: number[] = [];
  for (const query of queries) {
    const rawScores = corpus.map((vec) => cosineSim(query, vec));
    const quantScores = quantizedCorpus.map((vec) => cosineSim(query, vec));
    rhos.push(spearmanRho(rawScores, quantScores));
  }
  return rhos;
}
