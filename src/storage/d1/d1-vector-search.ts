/**
 * D1 vector search: brute-force cosine similarity over Float32Array embeddings
 * loaded from the D1 embeddings table.
 *
 * Same algorithm as extensions/embeddings/vector-search.ts but uses D1 async
 * APIs. D1 returns ArrayBuffer for BLOB columns, which is simpler than
 * better-sqlite3's Buffer (no byteOffset pitfall).
 */

import type { D1Database } from "./d1-types.js";
import { blobToFloat32 } from "../../extensions/quantization/turbo-quant.js";

/** A single vector search result. */
export interface D1VectorSearchResult {
  entryId: string;
  score: number;
}

/** Row shape from the D1 embeddings table. */
interface D1EmbeddingRow {
  id: string;
  embedding: ArrayBuffer;
}

/**
 * D1VectorSearch loads embeddings from D1 and ranks them by cosine similarity
 * against a query vector. Loads embeddings lazily per-call (no cross-call cache).
 */
export class D1VectorSearch {
  constructor(private db: D1Database) {}

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
    // Load all embeddings for this project by joining with the knowledge table
    let sql = `
      SELECT e.id, e.embedding
      FROM embeddings e
      JOIN knowledge k ON k.id = e.id
      WHERE LOWER(k.project) LIKE '%' || LOWER(?) || '%'
    `;
    const params: unknown[] = [project];

    if (user) {
      sql += " AND k.user = ?";
      params.push(user);
    }

    const result = await this.db.prepare(sql).bind(...params).all<D1EmbeddingRow>();
    const rows = result.results;

    if (rows.length === 0) return [];

    const results: D1VectorSearchResult[] = [];

    for (const row of rows) {
      // Convert D1 response to Buffer for blobToFloat32 (handles both Float32 and quantized formats)
      const raw = row.embedding instanceof ArrayBuffer
        ? Buffer.from(row.embedding)
        : Buffer.from(new Uint8Array(row.embedding as unknown as number[]));

      // blobToFloat32 uses blob size to discriminate Float32 (12,288 bytes for 3072 dims)
      // from quantized formats. For non-standard-dimension vectors (e.g. test fixtures),
      // fall back to raw Float32 deserialization when the size is a multiple of 4.
      let vec: Float32Array;
      try {
        vec = blobToFloat32(raw);
      } catch {
        // Fallback: treat as raw Float32 (e.g. test vectors with fewer dimensions)
        vec = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
      }

      const score = cosineSimilarity(queryVec, vec);

      // Exclude anti-correlated and zero-similarity results
      if (score > 0.0) {
        results.push({ entryId: row.id, score });
      }
    }

    // Sort descending by score
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
