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
import type { IVectorSearch, VectorSearchResult } from "../../extensions/embeddings/vector-search.js";
import { blobToFloat32, isQuantizedBlob } from "../../extensions/quantization/turbo-quant.js";
import { quantizedSearch, type QuantizedSearchInput } from "../../extensions/quantization/quantized-search.js";
import { CONFIG } from "../../config.js";
import { resolveActiveEmbeddingModel } from "../../extensions/embeddings/active-model.js";

/** A single vector search result. */
export interface PgVectorSearchResult {
  entryId: string;
  score: number;
}

/** Row shape from the Postgres embeddings table. */
interface PgEmbeddingRow {
  id: string;
  embedding: Buffer;
  format?: string | null;
}

/**
 * PgVectorSearch loads embeddings from Postgres and ranks them using
 * quantized-domain ADC/SDC search for quantized vectors, with cosine
 * similarity fallback for Float32.
 *
 * The `activeModel` constructor arg scopes all read queries so cross-provider
 * residue is never scored. Defaults to resolveActiveEmbeddingModel().model.
 */
export class PgVectorSearch implements IVectorSearch {
  private activeModel: string;
  constructor(private pool: PgPool, activeModel?: string) {
    this.activeModel = activeModel ?? resolveActiveEmbeddingModel().model;
  }

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
  ): Promise<VectorSearchResult[]> {
    let sql = `
      SELECT e.id, e.embedding, e.format
      FROM embeddings e
      JOIN knowledge k ON k.id = e.id
      WHERE LOWER(k.project) LIKE '%' || LOWER($1) || '%'
        AND e.model = $2
    `;
    const params: unknown[] = [project, this.activeModel];
    let paramIdx = 3;

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
  ): Promise<VectorSearchResult[]> {
    const { rows } = await this.pool.query<PgEmbeddingRow>(
      "SELECT id, embedding, format FROM embeddings WHERE model = $1",
      [this.activeModel]
    );
    return this.rankByCosine(rows, queryVec, limit);
  }

  /**
   * Search document chunk embeddings by cosine similarity.
   *
   * IMPORTANT: document chunks are written with the DOCUMENT model
   * (CONFIG.embeddings.documentModel = 'gemini-embedding-2-preview'), NOT with
   * the text embedding model (this.activeModel). Always scope to documentModel here.
   */
  async searchDocumentChunks(
    queryVec: Float32Array,
    limit: number,
    project?: string
  ): Promise<VectorSearchResult[]> {
    // Document chunks use the document model, not the active text model.
    const docModel = CONFIG.embeddings.documentModel;
    let rows: PgEmbeddingRow[];

    if (project) {
      const result = await this.pool.query<{ entry_id: string; embedding: Buffer; format?: string }>(
        `SELECT dc.id as entry_id, dc.embedding, dc.format
         FROM document_chunks dc
         JOIN stored_documents sd ON sd.id = dc.document_id
         WHERE LOWER(sd.project) LIKE '%' || LOWER($1) || '%'
           AND dc.model = $2`,
        [project, docModel]
      );
      rows = result.rows.map((r) => ({ id: r.entry_id, embedding: r.embedding, format: r.format }));
    } else {
      const result = await this.pool.query<{ entry_id: string; embedding: Buffer; format?: string }>(
        "SELECT id as entry_id, embedding, format FROM document_chunks WHERE model = $1",
        [docModel]
      );
      rows = result.rows.map((r) => ({ id: r.entry_id, embedding: r.embedding, format: r.format }));
    }

    return this.rankByCosine(rows, queryVec, limit);
  }

  /**
   * Search turn embeddings (knowledge_turn_embeddings) by cosine similarity,
   * scoped to a user_id and optionally project via a JOIN to knowledge_turns.
   * Mirrors VectorSearch.searchTurnEmbeddings (src/extensions/embeddings/vector-search.ts).
   * Returns [] when knowledge_turn_embeddings is empty (PG has no turn-write path yet).
   *
   * CORRECTION 4: SQL uses `te.turn_id AS id` to align with PgEmbeddingRow.id field
   * that rankByCosine reads. Do NOT use `AS entry_id` — rankByCosine reads `row.id`.
   */
  async searchTurnEmbeddings(
    queryVec: Float32Array,
    limit: number,
    opts?: { userId?: string | null; project?: string | null }
  ): Promise<VectorSearchResult[]> {
    const conditions: string[] = ["te.model = $1"];
    const params: unknown[] = [this.activeModel];
    let paramIdx = 2;

    if (opts && opts.userId !== undefined) {
      if (opts.userId === null) {
        conditions.push("t.user_id IS NULL");
      } else {
        conditions.push(`t.user_id = $${paramIdx++}`);
        params.push(opts.userId);
      }
    }
    if (opts && opts.project !== undefined && opts.project !== null) {
      conditions.push(`t.project = $${paramIdx++}`);
      params.push(opts.project);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;
    const sql = `
      SELECT te.turn_id AS id, te.embedding, te.format
      FROM knowledge_turn_embeddings te
      JOIN knowledge_turns t ON t.turn_id = te.turn_id
      ${where}
    `;

    const { rows } = await this.pool.query<PgEmbeddingRow>(sql, params);
    return this.rankByCosine(rows, queryVec, limit);
  }

  /** Rank embedding rows -- dispatches quantized blobs to fast path */
  private rankByCosine(
    rows: PgEmbeddingRow[],
    queryVec: Float32Array,
    limit: number
  ): VectorSearchResult[] {
    if (rows.length === 0) return [];

    // Partition by format: use format column (authoritative) or byte-length heuristic for legacy.
    const quantizedInputs: QuantizedSearchInput[] = [];
    const float32Rows: { id: string; buf: Buffer; format?: string | null }[] = [];

    for (const row of rows) {
      const buf = Buffer.isBuffer(row.embedding)
        ? row.embedding
        : Buffer.from(row.embedding as unknown as ArrayBuffer);

      const fmt = row.format ?? null;
      const isQuantized = fmt ? fmt.startsWith("tq") : isQuantizedBlob(buf);
      if (isQuantized) {
        quantizedInputs.push({ entryId: row.id, blob: buf });
      } else {
        float32Rows.push({ id: row.id, buf, format: fmt });
      }
    }

    const results: VectorSearchResult[] = [];

    // Dimension guard for quantized path: quantized blobs are ALWAYS Gemini-3072.
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
      // Quantization disabled -- dequantize and use cosine
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
