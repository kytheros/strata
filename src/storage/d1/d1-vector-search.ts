/**
 * D1 vector search: quantized-domain ADC/SDC search with Float32 fallback.
 *
 * Uses the same dispatch pattern as extensions/embeddings/vector-search.ts:
 * partitions blobs by format, routes quantized vectors to the fast ADC/SDC
 * pipeline, falls back to cosine similarity for Float32 vectors.
 *
 * D1 returns ArrayBuffer for BLOB columns (simpler than better-sqlite3's Buffer).
 *
 * The `activeModel` constructor arg scopes all reads to the active model so
 * cross-provider residue is never scored. D1 stays Gemini/OpenAI-only (no local).
 */

import type { D1Database } from "./d1-types.js";
import { blobToFloat32 } from "../../extensions/quantization/turbo-quant.js";
import { quantizedSearch, type QuantizedSearchInput } from "../../extensions/quantization/quantized-search.js";
import { HEADER_VERSION } from "../../extensions/quantization/codec.js";
import { CONFIG } from "../../config.js";
import { resolveActiveEmbeddingModel } from "../../extensions/embeddings/active-model.js";

const FLOAT32_3072_SIZE = 3072 * 4; // 12,288 bytes

/** A single vector search result. */
export interface D1VectorSearchResult {
  entryId: string;
  score: number;
}

/** Row shape from the D1 embeddings table. */
interface D1EmbeddingRow {
  id: string;
  embedding: ArrayBuffer;
  format?: string | null;
}

/**
 * D1VectorSearch loads embeddings from D1 and ranks them using quantized-domain
 * ADC/SDC search for quantized vectors, with cosine similarity fallback for Float32.
 *
 * All read queries are scoped to `activeModel` (defaults to resolveActiveEmbeddingModel().model).
 */
export class D1VectorSearch {
  private activeModel: string;

  constructor(private db: D1Database, activeModel?: string) {
    this.activeModel = activeModel ?? resolveActiveEmbeddingModel().model;
  }

  /**
   * Search for the most similar embeddings to the query vector.
   * Filters to entries belonging to the given project and optionally to a user.
   * Returns results sorted by descending cosine similarity, limited to `limit`.
   * Entries with score <= 0 are excluded.
   */
  async search(
    queryVec: Float32Array,
    project: string,
    limit: number,
    user?: string
  ): Promise<D1VectorSearchResult[]> {
    let sql = `
      SELECT e.id, e.embedding, e.format
      FROM embeddings e
      JOIN knowledge k ON k.id = e.id
      WHERE LOWER(k.project) LIKE '%' || LOWER(?) || '%'
        AND e.model = ?
    `;
    const params: unknown[] = [project, this.activeModel];

    if (user) {
      sql += " AND k.user = ?";
      params.push(user);
    }

    const result = await this.db.prepare(sql).bind(...params).all<D1EmbeddingRow>();
    const rows = result.results;

    if (rows.length === 0) return [];

    return this.rankByCosine(rows, queryVec, limit);
  }

  /** Rank D1 embedding rows using quantized or float32 cosine similarity. */
  private rankByCosine(
    rows: D1EmbeddingRow[],
    queryVec: Float32Array,
    limit: number
  ): D1VectorSearchResult[] {
    // Partition by format: use format column (authoritative) or legacy header-byte heuristic.
    const quantizedInputs: QuantizedSearchInput[] = [];
    const float32Rows: { id: string; buf: Buffer; format?: string | null }[] = [];

    for (const row of rows) {
      const buf = row.embedding instanceof ArrayBuffer
        ? Buffer.from(row.embedding)
        : Buffer.from(new Uint8Array(row.embedding as unknown as number[]));

      const fmt = row.format ?? null;
      const isQuantized = fmt
        ? fmt.startsWith("tq")
        : (buf.length !== FLOAT32_3072_SIZE && buf.length >= 4 && buf[0] === HEADER_VERSION);

      if (isQuantized) {
        quantizedInputs.push({ entryId: row.id, blob: buf });
      } else {
        float32Rows.push({ id: row.id, buf, format: fmt });
      }
    }

    const results: D1VectorSearchResult[] = [];

    // Dimension guard for quantized path (always Gemini-3072).
    const geminiDim = CONFIG.quantization.embeddingDim;
    const quantizedForThisQuery = queryVec.length === geminiDim ? quantizedInputs : [];

    // Fast path: quantized-domain ADC/SDC search
    if (quantizedForThisQuery.length > 0 && CONFIG.quantization.enabled) {
      const bitWidth = CONFIG.quantization.bitWidth as 1 | 2 | 4 | 8;
      const qResults = quantizedSearch(queryVec, quantizedForThisQuery, limit, bitWidth);
      for (const r of qResults) {
        results.push({ entryId: r.entryId, score: r.score });
      }
    } else if (quantizedForThisQuery.length > 0) {
      // Quantization disabled — dequantize and use cosine
      for (const item of quantizedForThisQuery) {
        try {
          const vec = blobToFloat32(item.blob as Buffer);
          if (vec.length !== queryVec.length) continue;
          const score = cosineSimilarity(queryVec, vec);
          if (score > 0.0) results.push({ entryId: item.entryId, score });
        } catch {
          // Skip malformed vectors
        }
      }
    }

    // Fallback path: Float32 cosine similarity (format-aware decode via T4)
    for (const row of float32Rows) {
      try {
        const vec = blobToFloat32(row.buf, row.format);
        // Dimension guard: skip cross-provider / wrong-dimension residue
        if (vec.length !== queryVec.length) continue;
        const score = cosineSimilarity(queryVec, vec);
        if (score > 0.0) results.push({ entryId: row.id, score });
      } catch {
        // Skip malformed vectors (e.g. test fixtures with non-standard dimensions)
      }
    }

    // Merge and sort
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
}

/**
 * Cosine similarity: dot(a, b) / (|a| * |b|).
 * Returns 0.0 if either vector has zero magnitude (avoids NaN).
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  // Guard against zero-vector division
  if (magA === 0 || magB === 0) return 0.0;

  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
