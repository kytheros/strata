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
import { resolveActiveEmbeddingModel } from "./active-model.js";

/** A single vector search result */
export interface VectorSearchResult {
  entryId: string;
  score: number;
}

/** Row shape from the embeddings table */
interface EmbeddingRow {
  entry_id: string;
  embedding: Buffer;
  format?: string | null;
}

/**
 * VectorSearch loads embeddings from SQLite and ranks them by cosine similarity
 * against a query vector. Loads embeddings lazily per-call (no cross-call cache).
 *
 * The `activeModel` constructor arg scopes all knowledge-lane reads (search,
 * searchAll, searchDocumentChunks) to only that model's vectors. Defaults to
 * resolveActiveEmbeddingModel().model so legacy callers without the arg are
 * automatically correct. searchTurnEmbeddings is excluded (dense-turn-lane owned).
 */
export class VectorSearch {
  private activeModel: string;
  constructor(private db: Database.Database, activeModel?: string) {
    // Default to the currently-active model if not supplied.
    this.activeModel = activeModel ?? resolveActiveEmbeddingModel().model;
  }

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
    // Load all embeddings for this project by joining with the knowledge table,
    // scoped to the active model so cross-provider residue is never scored.
    const rows = this.db
      .prepare(
        `SELECT e.entry_id, e.embedding, e.format
         FROM embeddings e
         JOIN knowledge k ON k.id = e.entry_id
         WHERE LOWER(k.project) LIKE '%' || LOWER(?) || '%'
           AND e.model = ?`
      )
      .all(project, this.activeModel) as EmbeddingRow[];

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
      .prepare(`SELECT entry_id, embedding, format FROM embeddings WHERE model = ?`)
      .all(this.activeModel) as EmbeddingRow[];

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
          `SELECT dc.id as entry_id, dc.embedding, dc.format
           FROM document_chunks dc
           JOIN stored_documents sd ON sd.id = dc.document_id
           WHERE LOWER(sd.project) LIKE '%' || LOWER(?) || '%'
             AND dc.model = ?`
        )
        .all(project, this.activeModel) as EmbeddingRow[];
    } else {
      rows = this.db
        .prepare(
          `SELECT id as entry_id, embedding, format FROM document_chunks WHERE model = ?`
        )
        .all(this.activeModel) as EmbeddingRow[];
    }

    return this.rankByCosine(rows, queryVec, limit);
  }

  /**
   * Search turn embeddings (knowledge_turn_embeddings) by cosine similarity,
   * scoped to a user_id (and optionally project) via a JOIN to knowledge_turns.
   * Mirrors searchDocumentChunks. Reuses rankByCosine (quantized/float32).
   * Spec: 2026-06-02-dense-turn-lane-design §3.3.
   */
  searchTurnEmbeddings(
    queryVec: Float32Array,
    limit: number,
    opts?: { userId?: string | null; project?: string | null }
  ): VectorSearchResult[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts && opts.userId !== undefined) {
      if (opts.userId === null) {
        conditions.push("t.user_id IS NULL");
      } else {
        conditions.push("t.user_id = ?");
        params.push(opts.userId);
      }
    }
    if (opts && opts.project !== undefined && opts.project !== null) {
      conditions.push("t.project = ?");
      params.push(opts.project);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT te.turn_id AS entry_id, te.embedding
         FROM knowledge_turn_embeddings te
         JOIN knowledge_turns t ON t.turn_id = te.turn_id
         ${where}`
      )
      .all(...params) as EmbeddingRow[];

    return this.rankByCosine(rows, queryVec, limit);
  }

  /** Rank embedding rows — dispatches quantized blobs to fast path */
  private rankByCosine(
    rows: EmbeddingRow[],
    queryVec: Float32Array,
    limit: number
  ): VectorSearchResult[] {
    if (rows.length === 0) return [];

    // Partition by format: use format column (authoritative) or fall back to byte-length heuristic.
    const quantizedInputs: QuantizedSearchInput[] = [];
    const float32Rows: EmbeddingRow[] = [];

    for (const row of rows) {
      const fmt = row.format ?? null;
      const isQuantized = fmt ? fmt.startsWith("tq") : isQuantizedBlob(row.embedding);
      if (isQuantized) {
        quantizedInputs.push({ entryId: row.entry_id, blob: row.embedding });
      } else {
        float32Rows.push(row);
      }
    }

    const results: VectorSearchResult[] = [];

    // Dimension guard for quantized path: quantized blobs are ALWAYS Gemini-3072.
    // A non-3072-dim query cannot belong to this space — evict all quantized inputs
    // rather than letting quantizedSearch() ADC-score with a mismatched query.
    const geminiEmbeddingDim = CONFIG.quantization.embeddingDim; // 3072
    const quantizedForThisQuery =
      queryVec.length === geminiEmbeddingDim ? quantizedInputs : [];
    if (quantizedInputs.length > 0 && quantizedForThisQuery.length === 0) {
      process.stderr.write(
        `[strata] Evicted ${quantizedInputs.length} quantized blob(s): query dim ${queryVec.length} != stored dim ${geminiEmbeddingDim}\n`
      );
    }

    // Fast path: quantized-domain search (ADC/SDC)
    if (quantizedForThisQuery.length > 0 && CONFIG.quantization.enabled) {
      const bitWidth = CONFIG.quantization.bitWidth as 1 | 2 | 4 | 8;
      const qResults = quantizedSearch(queryVec, quantizedForThisQuery, limit, bitWidth);
      for (const r of qResults) {
        results.push({ entryId: r.entryId, score: r.score });
      }
    } else if (quantizedForThisQuery.length > 0) {
      // Quantization disabled — dequantize and use cosine
      for (const item of quantizedForThisQuery) {
        const vec = blobToFloat32(item.blob as Buffer);
        // Dimension guard: skip cross-provider residue (belt-and-suspenders)
        if (vec.length !== queryVec.length) continue;
        const score = cosineSimilarity(queryVec, vec);
        if (score > 0.0) results.push({ entryId: item.entryId, score });
      }
    }

    // Fallback path: Float32 cosine similarity
    for (const row of float32Rows) {
      const vec = blobToFloat32(row.embedding, row.format);
      // Dimension guard: skip cross-provider / wrong-dimension residue
      if (vec.length !== queryVec.length) continue;
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
