/**
 * Hybrid search combining FTS5 BM25 + vector cosine similarity via RRF.
 *
 * Extends the existing result-ranker.ts infrastructure for score fusion.
 */

import type { SqliteDocumentStore } from "../storage/sqlite-document-store.js";
import type { VectorStore, VectorSearchResult } from "../extensions/vector-search/vector-store.js";
import type { EmbeddingProvider } from "../extensions/vector-search/embedding-provider.js";
import { reciprocalRankFusion, applyBoosts, applyFilters, type RankedResult } from "./result-ranker.js";
import { parseQuery } from "./query-processor.js";
import type { DocumentChunk } from "../indexing/document-store.js";

export interface HybridSearchOptions {
  /** Maximum results to return. */
  limit?: number;
  /** Filter to specific project. */
  project?: string;
  /** Current project for boost. */
  currentProject?: string;
  /** Minimum cosine similarity threshold. */
  threshold?: number;
  /** BM25 weight in RRF (default: 0.5). */
  bm25Weight?: number;
  /** Vector weight in RRF (default: 0.5). */
  vectorWeight?: number;
}

export interface HybridSearchResult {
  sessionId: string;
  project: string;
  text: string;
  score: number;
  timestamp: number;
  toolNames: string[];
  role: "user" | "assistant" | "mixed";
  /** Whether this result came from vector search, BM25, or both. */
  source: "bm25" | "vector" | "hybrid";
}

/**
 * Hybrid search engine combining BM25 full-text and vector semantic search.
 */
export class HybridSearchEngine {
  constructor(
    private documentStore: SqliteDocumentStore,
    private vectorStore: VectorStore,
    private embeddingProvider: EmbeddingProvider
  ) {}

  /**
   * Search using both BM25 and vector similarity, fused via RRF.
   */
  async search(
    rawQuery: string,
    options: HybridSearchOptions = {}
  ): Promise<HybridSearchResult[]> {
    const { text, filters } = parseQuery(rawQuery);

    if (options.project && !filters.project) {
      filters.project = options.project;
    }

    const limit = Math.min(options.limit || 20, 100);
    const fetchLimit = limit * 3;

    if (!text.trim()) return [];

    // Run BM25 and vector search in parallel
    const [bm25Results, vectorResults] = await Promise.all([
      this.bm25Search(text, fetchLimit),
      this.vectorSearch(text, fetchLimit, options.threshold),
    ]);

    // Build doc lookup from BM25 results
    const docMap = new Map<string, DocumentChunk>();
    for (const r of bm25Results) {
      docMap.set(r.docId, r.doc);
    }

    // Also look up docs for vector-only results
    for (const vr of vectorResults) {
      if (!docMap.has(vr.documentId)) {
        const doc = this.documentStore.get(vr.documentId);
        if (doc) {
          docMap.set(vr.documentId, doc);
        }
      }
    }

    // Track which results came from which source
    const bm25DocIds = new Set(bm25Results.map((r) => r.docId));
    const vectorDocIds = new Set(vectorResults.map((r) => r.documentId));

    // Prepare ranked lists for RRF
    const bm25List = bm25Results.map((r) => ({
      docId: r.docId,
      score: r.score,
    }));

    const vectorList = vectorResults.map((r) => ({
      docId: r.documentId,
      score: 1 - r.distance, // Convert distance to similarity
    }));

    // Apply RRF fusion
    const rrfScores = reciprocalRankFusion(bm25List, vectorList);

    // Build ranked results
    const ranked: RankedResult[] = [];
    for (const [docId, score] of rrfScores) {
      const doc = docMap.get(docId);
      if (doc) {
        ranked.push({ docId, score, doc });
      }
    }

    // Apply filters and boosts
    const filtered = applyFilters(ranked, filters);
    const boosted = applyBoosts(filtered, filters, options.currentProject);

    // Convert to results with source tracking
    return boosted.slice(0, limit).map((r) => {
      const inBm25 = bm25DocIds.has(r.docId);
      const inVector = vectorDocIds.has(r.docId);
      const source: "bm25" | "vector" | "hybrid" =
        inBm25 && inVector ? "hybrid" : inBm25 ? "bm25" : "vector";

      return {
        sessionId: r.doc.sessionId,
        project: r.doc.project,
        text: r.doc.text,
        score: r.score,
        timestamp: r.doc.timestamp,
        toolNames: r.doc.toolNames,
        role: r.doc.role,
        source,
      };
    });
  }

  private bm25Search(text: string, limit: number): Promise<RankedResult[]> {
    const ftsResults = this.documentStore.search(text, limit);
    const ranked = ftsResults.map((r) => ({
      docId: r.chunk.id,
      score: -r.rank,
      doc: r.chunk,
    }));
    return Promise.resolve(ranked);
  }

  private async vectorSearch(
    text: string,
    limit: number,
    threshold?: number
  ): Promise<VectorSearchResult[]> {
    try {
      const queryVector = await this.embeddingProvider.embed(text, "CODE_RETRIEVAL_QUERY");
      return this.vectorStore.search(queryVector, limit, threshold);
    } catch {
      // If embedding fails, return empty (BM25 still works)
      return [];
    }
  }
}
