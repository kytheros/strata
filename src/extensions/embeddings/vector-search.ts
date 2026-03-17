/**
 * Vector search: brute-force cosine similarity over Float32Array embeddings
 * loaded from the SQLite embeddings table.
 *
 * No external math library -- typed-array loops only.
 */

import type Database from "better-sqlite3";

/** A single vector search result */
export interface VectorSearchResult {
  entryId: string;
  score: number;
}

/** Row shape from the embeddings table */
interface EmbeddingRow {
  entry_id: string;
  embedding: Buffer;
}

/**
 * VectorSearch loads embeddings from SQLite and ranks them by cosine similarity
 * against a query vector. Loads embeddings lazily per-call (no cross-call cache).
 */
export class VectorSearch {
  constructor(private db: Database.Database) {}

  /**
   * Search for the most similar embeddings to the query vector.
   * Filters to entries belonging to the given project.
   * Returns results sorted by descending cosine similarity, limited to `limit`.
   * Entries with score < 0.0 are excluded.
   */
  search(
    queryVec: Float32Array,
    project: string,
    limit: number
  ): VectorSearchResult[] {
    // Load all embeddings for this project by joining with the knowledge table
    const rows = this.db
      .prepare(
        `SELECT e.entry_id, e.embedding
         FROM embeddings e
         JOIN knowledge k ON k.id = e.entry_id
         WHERE LOWER(k.project) LIKE '%' || LOWER(?) || '%'`
      )
      .all(project) as EmbeddingRow[];

    if (rows.length === 0) return [];

    const results: VectorSearchResult[] = [];

    for (const row of rows) {
      // Deserialize BLOB to Float32Array, handling byteOffset pitfall
      const buf = row.embedding;
      const vec = new Float32Array(
        buf.buffer,
        buf.byteOffset,
        buf.byteLength / 4
      );

      const score = cosineSimilarity(queryVec, vec);

      // Exclude anti-correlated and zero-similarity results
      if (score > 0.0) {
        results.push({ entryId: row.entry_id, score });
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
