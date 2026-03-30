/**
 * Vector search: brute-force cosine similarity over Float32Array embeddings
 * loaded from the SQLite embeddings table.
 *
 * No external math library -- typed-array loops only.
 */

import type Database from "better-sqlite3";
import { blobToFloat32, isQuantizedBlob } from "../quantization/turbo-quant.js";
import { quantizedSearch, type QuantizedSearchInput } from "../quantization/quantized-search.js";
import { CONFIG } from "../../config.js";

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

    return this.rankByCosine(rows, queryVec, limit);
  }

  /**
   * Search ALL embeddings without project filtering or knowledge table join.
   * Useful when embeddings are stored for document chunks (not knowledge entries)
   * or when the database is scoped per-query (e.g., benchmarks with isolated DBs).
   */
  searchAll(
    queryVec: Float32Array,
    limit: number
  ): VectorSearchResult[] {
    const rows = this.db
      .prepare(`SELECT entry_id, embedding FROM embeddings`)
      .all() as EmbeddingRow[];

    return this.rankByCosine(rows, queryVec, limit);
  }

  /**
   * Search document chunk embeddings by cosine similarity.
   * Returns results from the document_chunks table, tagged with source: "document".
   */
  searchDocumentChunks(
    queryVec: Float32Array,
    limit: number,
    project?: string
  ): VectorSearchResult[] {
    let rows: EmbeddingRow[];

    if (project) {
      rows = this.db
        .prepare(
          `SELECT dc.id as entry_id, dc.embedding
           FROM document_chunks dc
           JOIN stored_documents sd ON sd.id = dc.document_id
           WHERE LOWER(sd.project) LIKE '%' || LOWER(?) || '%'`
        )
        .all(project) as EmbeddingRow[];
    } else {
      rows = this.db
        .prepare(
          `SELECT id as entry_id, embedding FROM document_chunks`
        )
        .all() as EmbeddingRow[];
    }

    return this.rankByCosine(rows, queryVec, limit);
  }

  /** Rank embedding rows — dispatches quantized blobs to fast path */
  private rankByCosine(
    rows: EmbeddingRow[],
    queryVec: Float32Array,
    limit: number
  ): VectorSearchResult[] {
    if (rows.length === 0) return [];

    // Partition by format
    const quantizedInputs: QuantizedSearchInput[] = [];
    const float32Rows: EmbeddingRow[] = [];

    for (const row of rows) {
      if (isQuantizedBlob(row.embedding)) {
        quantizedInputs.push({ entryId: row.entry_id, blob: row.embedding });
      } else {
        float32Rows.push(row);
      }
    }

    const results: VectorSearchResult[] = [];

    // Fast path: quantized-domain search (ADC/SDC)
    if (quantizedInputs.length > 0 && CONFIG.quantization.enabled) {
      const bitWidth = CONFIG.quantization.bitWidth as 1 | 2 | 4 | 8;
      const qResults = quantizedSearch(queryVec, quantizedInputs, limit, bitWidth);
      for (const r of qResults) {
        results.push({ entryId: r.entryId, score: r.score });
      }
    } else if (quantizedInputs.length > 0) {
      // Quantization disabled — dequantize and use cosine
      for (const item of quantizedInputs) {
        const vec = blobToFloat32(item.blob as Buffer);
        const score = cosineSimilarity(queryVec, vec);
        if (score > 0.0) results.push({ entryId: item.entryId, score });
      }
    }

    // Fallback path: Float32 cosine similarity
    for (const row of float32Rows) {
      const buf = row.embedding;
      const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      const score = cosineSimilarity(queryVec, vec);
      if (score > 0.0) results.push({ entryId: row.entry_id, score });
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
