/**
 * Postgres vector search: quantized-domain ADC/SDC search with Float32 fallback.
 *
 * Port of extensions/embeddings/vector-search.ts for Postgres.
 * Same dispatch pattern: partitions blobs by format, routes quantized vectors
 * to the fast ADC/SDC pipeline, falls back to cosine similarity for Float32.
 *
 * Postgres returns Buffer for bytea columns (same as better-sqlite3).
 */

import type { PgPool } from "./pg-types.js";
import { blobToFloat32, isQuantizedBlob } from "../../extensions/quantization/turbo-quant.js";
import { quantizedSearch, type QuantizedSearchInput } from "../../extensions/quantization/quantized-search.js";
import { CONFIG } from "../../config.js";

/** A single vector search result. */
export interface PgVectorSearchResult {
  entryId: string;
  score: number;
}

/** Row shape from the Postgres embeddings table. */
interface PgEmbeddingRow {
  id: string;
  embedding: Buffer;
}

/**
 * PgVectorSearch loads embeddings from Postgres and ranks them using
 * quantized-domain ADC/SDC search for quantized vectors, with cosine
 * similarity fallback for Float32.
 */
export class PgVectorSearch {
  constructor(private pool: PgPool) {}

  /**
   * Search for the most similar knowledge embeddings to the query vector.
   * Filters to entries belonging to the given project and optionally to a user.
   * Returns results sorted by descending cosine similarity, limited to `limit`.
   * Entries with score <= 0 are excluded.
   */
  async search(
    queryVec: Float32Array,
    project: string,
    limit: number,
    user?: string
  ): Promise<PgVectorSearchResult[]> {
    let sql = `
      SELECT e.id, e.embedding
      FROM embeddings e
      JOIN knowledge k ON k.id = e.id
      WHERE LOWER(k.project) LIKE '%' || LOWER($1) || '%'
    `;
    const params: unknown[] = [project];
    let paramIdx = 2;

    if (user) {
      sql += ` AND k.user_scope = $${paramIdx}`;
      params.push(user);
    }

    const { rows } = await this.pool.query<PgEmbeddingRow>(sql, params);
    return this.rankByCosine(rows, queryVec, limit);
  }

  /**
   * Search ALL embeddings without project filtering.
   * Useful for benchmarks or when the scope is handled upstream.
   */
  async searchAll(
    queryVec: Float32Array,
    limit: number
  ): Promise<PgVectorSearchResult[]> {
    const { rows } = await this.pool.query<PgEmbeddingRow>(
      "SELECT id, embedding FROM embeddings"
    );
    return this.rankByCosine(rows, queryVec, limit);
  }

  /**
   * Search document chunk embeddings by cosine similarity.
   */
  async searchDocumentChunks(
    queryVec: Float32Array,
    limit: number,
    project?: string
  ): Promise<PgVectorSearchResult[]> {
    let rows: PgEmbeddingRow[];

    if (project) {
      const result = await this.pool.query<{ entry_id: string; embedding: Buffer }>(
        `SELECT dc.id as entry_id, dc.embedding
         FROM document_chunks dc
         JOIN stored_documents sd ON sd.id = dc.document_id
         WHERE LOWER(sd.project) LIKE '%' || LOWER($1) || '%'`,
        [project]
      );
      rows = result.rows.map((r) => ({ id: r.entry_id, embedding: r.embedding }));
    } else {
      const result = await this.pool.query<{ entry_id: string; embedding: Buffer }>(
        "SELECT id as entry_id, embedding FROM document_chunks"
      );
      rows = result.rows.map((r) => ({ id: r.entry_id, embedding: r.embedding }));
    }

    return this.rankByCosine(rows, queryVec, limit);
  }

  /** Rank embedding rows -- dispatches quantized blobs to fast path */
  private rankByCosine(
    rows: PgEmbeddingRow[],
    queryVec: Float32Array,
    limit: number
  ): PgVectorSearchResult[] {
    if (rows.length === 0) return [];

    // Partition by format
    const quantizedInputs: QuantizedSearchInput[] = [];
    const float32Rows: { id: string; buf: Buffer }[] = [];

    for (const row of rows) {
      const buf = Buffer.isBuffer(row.embedding)
        ? row.embedding
        : Buffer.from(row.embedding as unknown as ArrayBuffer);

      if (isQuantizedBlob(buf)) {
        quantizedInputs.push({ entryId: row.id, blob: buf });
      } else {
        float32Rows.push({ id: row.id, buf });
      }
    }

    const results: PgVectorSearchResult[] = [];

    // Fast path: quantized-domain ADC/SDC search
    if (quantizedInputs.length > 0 && CONFIG.quantization.enabled) {
      const bitWidth = CONFIG.quantization.bitWidth as 1 | 2 | 4 | 8;
      const qResults = quantizedSearch(queryVec, quantizedInputs, limit, bitWidth);
      for (const r of qResults) {
        results.push({ entryId: r.entryId, score: r.score });
      }
    } else if (quantizedInputs.length > 0) {
      // Quantization disabled -- dequantize and use cosine
      for (const item of quantizedInputs) {
        try {
          const vec = blobToFloat32(item.blob as Buffer);
          const score = cosineSimilarity(queryVec, vec);
          if (score > 0.0) results.push({ entryId: item.entryId, score });
        } catch {
          // Skip malformed vectors
        }
      }
    }

    // Fallback path: Float32 cosine similarity
    for (const row of float32Rows) {
      try {
        const vec = new Float32Array(row.buf.buffer, row.buf.byteOffset, row.buf.byteLength / 4);
        const score = cosineSimilarity(queryVec, vec);
        if (score > 0.0) results.push({ entryId: row.id, score });
      } catch {
        // Skip malformed vectors
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
