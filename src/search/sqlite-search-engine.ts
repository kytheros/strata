/**
 * SQLite-backed search engine using FTS5 for full-text search.
 * Optionally runs hybrid search (FTS5 + vector cosine similarity via RRF)
 * when an embedder and VectorSearch instance are provided.
 */

import type { SqliteDocumentStore, FtsSearchResult } from "../storage/sqlite-document-store.js";
import { parseQuery, type QueryFilters } from "./query-processor.js";
import { applyBoosts, applyFilters, reciprocalRankFusion, type RankedResult } from "./result-ranker.js";
import type { GeminiEmbedder } from "../extensions/embeddings/gemini-embedder.js";
import type { VectorSearch, VectorSearchResult } from "../extensions/embeddings/vector-search.js";

export interface SearchResult {
  sessionId: string;
  project: string;
  text: string;
  score: number;
  confidence: number;
  timestamp: number;
  toolNames: string[];
  role: "user" | "assistant" | "mixed";
}

export interface SearchOptions {
  limit?: number;
  project?: string;
  currentProject?: string;
  includeContext?: boolean;
  user?: string;
}

/** Attach normalized confidence (0-1) to ranked results. Top result = 1.0. */
function attachConfidence(results: RankedResult[]): Array<RankedResult & { confidence: number }> {
  if (results.length === 0) return [];
  const topScore = results[0].score; // Already sorted descending
  return results.map((r) => ({
    ...r,
    confidence: topScore > 0 ? Math.round((r.score / topScore) * 100) / 100 : 0,
  }));
}

/** Convert ranked results to SearchResult[] with confidence. */
function toSearchResults(ranked: RankedResult[], limit: number): SearchResult[] {
  const withConfidence = attachConfidence(ranked.slice(0, limit));
  return withConfidence.map((r) => ({
    sessionId: r.doc.sessionId,
    project: r.doc.project,
    text: r.doc.text,
    score: r.score,
    confidence: r.confidence,
    timestamp: r.doc.timestamp,
    toolNames: r.doc.toolNames,
    role: r.doc.role,
  }));
}

export class SqliteSearchEngine {
  private embedder: GeminiEmbedder | null;
  private vectorSearch: VectorSearch | null;

  constructor(
    private documentStore: SqliteDocumentStore,
    embedder?: GeminiEmbedder | null,
    vectorSearch?: VectorSearch | null
  ) {
    this.embedder = embedder ?? null;
    this.vectorSearch = vectorSearch ?? null;
  }

  /**
   * Search conversations using FTS5, optionally fused with vector search via RRF.
   *
   * When both embedder and vectorSearch are available, the query is embedded and
   * vector search runs alongside FTS5. The two ranked lists are merged using
   * reciprocalRankFusion() before applying boosts and filters. If the embedding
   * call fails, search gracefully falls back to FTS5-only results.
   */
  search(rawQuery: string, options: SearchOptions = {}): SearchResult[] {
    const { text, filters } = parseQuery(rawQuery);

    // Merge explicit project option into filters
    if (options.project && !filters.project) {
      filters.project = options.project;
    }

    const limit = Math.min(options.limit || 20, 100);

    if (!text.trim()) return [];

    // FTS5 search — fetch extra results for post-filtering
    const ftsResults = this.documentStore.search(text, limit * 3, options.user);

    // Convert FTS results to RankedResult format for the ranker
    // FTS5 bm25() returns negative scores (more negative = more relevant)
    // Normalize to positive scores
    const ranked: RankedResult[] = ftsResults.map((r) => ({
      docId: r.chunk.id,
      score: -r.rank, // Flip sign so higher = better
      doc: r.chunk,
    }));

    // Apply query filters (project, before, after, tool)
    const filtered = applyFilters(ranked, filters);

    // Apply boosts (recency, project match) and dedup per session
    const boosted = applyBoosts(filtered, filters, options.currentProject);

    return toSearchResults(boosted, limit);
  }

  /**
   * Async search that supports hybrid FTS5 + vector search.
   * Falls back to FTS5-only when no embedder is configured or embedding fails.
   */
  async searchAsync(rawQuery: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { text, filters } = parseQuery(rawQuery);

    if (options.project && !filters.project) {
      filters.project = options.project;
    }

    const limit = Math.min(options.limit || 20, 100);

    if (!text.trim()) return [];

    // FTS5 search
    const ftsResults = this.documentStore.search(text, limit * 3, options.user);

    const ftsRanked: RankedResult[] = ftsResults.map((r) => ({
      docId: r.chunk.id,
      score: -r.rank,
      doc: r.chunk,
    }));

    // If hybrid search is available, run vector search in parallel
    if (this.embedder && this.vectorSearch) {
      try {
        const queryVec = await this.embedder.embed(text);
        const project = filters.project || options.currentProject || "";
        const vectorResults = this.vectorSearch.search(queryVec, project, limit * 3);

        if (vectorResults.length > 0) {
          // Build RRF input lists: FTS ranked by score desc, vector ranked by score desc
          const ftsList = ftsRanked
            .slice()
            .sort((a, b) => b.score - a.score)
            .map((r) => ({ docId: r.docId, score: r.score }));

          const vectorList = vectorResults.map((r) => ({
            docId: r.entryId,
            score: r.score,
          }));

          // Merge using Reciprocal Rank Fusion
          const fusedScores = reciprocalRankFusion(ftsList, vectorList);

          // Build a map of all docs by ID for lookup
          const docMap = new Map<string, RankedResult>();
          for (const r of ftsRanked) {
            docMap.set(r.docId, r);
          }

          // Create merged ranked list with fused scores
          const merged: RankedResult[] = [];
          for (const [docId, score] of fusedScores) {
            const existing = docMap.get(docId);
            if (existing) {
              merged.push({ ...existing, score });
            }
            // Vector-only results don't have a doc chunk from FTS,
            // so they can only contribute to RRF score for shared entries
          }

          // Sort by fused score
          merged.sort((a, b) => b.score - a.score);

          const filtered = applyFilters(merged, filters);
          const boosted = applyBoosts(filtered, filters, options.currentProject);

          return toSearchResults(boosted, limit);
        }
      } catch (err) {
        // Embedding failed — fall back to FTS5-only
        console.error("[strata] Vector search failed, falling back to FTS5:", err);
      }
    }

    // FTS5-only path (no embedder or vector search failed)
    const filtered = applyFilters(ftsRanked, filters);
    const boosted = applyBoosts(filtered, filters, options.currentProject);

    return toSearchResults(boosted, limit);
  }

  /**
   * Search specifically for error/solution patterns.
   */
  searchSolutions(
    errorOrProblem: string,
    technology?: string,
    user?: string
  ): SearchResult[] {
    let query = errorOrProblem;
    if (technology) {
      query = `${technology} ${query}`;
    }

    const results = this.search(query, { limit: 50, user });

    // Boost results containing solution indicators
    const solutionWords = [
      "fixed",
      "solved",
      "solution",
      "resolved",
      "issue was",
      "the problem",
      "worked",
      "working now",
    ];

    const boosted = results
      .map((r) => {
        const textLower = r.text.toLowerCase();
        const hasSolutionIndicator = solutionWords.some((w) =>
          textLower.includes(w)
        );
        return {
          ...r,
          score: hasSolutionIndicator ? r.score * 1.5 : r.score,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);

    // Recompute confidence after solution boost re-ranking
    if (boosted.length === 0) return boosted;
    const topScore = boosted[0].score;
    return boosted.map((r) => ({
      ...r,
      confidence: topScore > 0 ? Math.round((r.score / topScore) * 100) / 100 : 0,
    }));
  }
}
