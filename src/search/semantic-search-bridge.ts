/**
 * Semantic search bridge: adapts HybridSearchEngine to produce
 * community-compatible SearchResult[] for use by the search_history
 * and find_solutions tool handlers.
 *
 * Lazy-initializes the embedding provider, vector store, and hybrid
 * engine on first call. Gracefully degrades to null (caller falls back
 * to FTS5) when no embedding credentials are available.
 */

import type { IDocumentStore } from "../storage/interfaces/document-store.js";
import type Database from "better-sqlite3";
import type { SearchResult, SearchOptions } from "./sqlite-search-engine.js";

import { HybridSearchEngine, type HybridSearchResult } from "./hybrid-search.js";
import { VectorStore } from "../extensions/vector-search/vector-store.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "../extensions/vector-search/embedding-provider.js";

/**
 * Convert HybridSearchResult[] to community SearchResult[] (adds confidence).
 */
function toSearchResults(results: HybridSearchResult[]): SearchResult[] {
  if (results.length === 0) return [];
  const topScore = results[0].score;

  return results.map((r) => ({
    sessionId: r.sessionId,
    project: r.project,
    text: r.text,
    score: r.score,
    confidence: topScore > 0 ? Math.round((r.score / topScore) * 100) / 100 : 0,
    timestamp: r.timestamp,
    toolNames: r.toolNames,
    role: r.role,
  }));
}

/**
 * SemanticSearchBridge wraps the HybridSearchEngine and exposes
 * async search methods that return community-compatible SearchResult[].
 *
 * Usage:
 *   const bridge = new SemanticSearchBridge(documentStore, db);
 *   const results = await bridge.search(query, options);
 *   if (results === null) { // no embedder, use FTS5 fallback }
 */
export class SemanticSearchBridge {
  private engine: HybridSearchEngine | null = null;
  private provider: EmbeddingProvider | null = null;
  private vectorStore: VectorStore | null = null;
  private initAttempted = false;
  private initError = false;

  constructor(
    private documentStore: IDocumentStore,
    private db: Database.Database | null
  ) {}

  /**
   * Lazily initialize the hybrid search engine.
   * Returns false if initialization fails (no API key, missing deps, etc.).
   */
  private ensureEngine(): boolean {
    if (this.engine) return true;
    if (this.initAttempted) return !this.initError;

    this.initAttempted = true;

    // VectorStore requires a better-sqlite3 Database — not available on D1
    if (!this.db) {
      this.initError = true;
      return false;
    }

    try {
      this.provider = createEmbeddingProvider();
      this.vectorStore = new VectorStore(
        this.db,
        this.provider.dimensions,
        this.provider.modelName
      );
      this.engine = new HybridSearchEngine(
        this.documentStore,
        this.vectorStore,
        this.provider
      );
      return true;
    } catch {
      this.initError = true;
      // Embedding provider unavailable (no API key, etc.) -- degrade gracefully
      return false;
    }
  }

  /**
   * Hybrid search: FTS5 + vector similarity via RRF.
   *
   * Returns community-compatible SearchResult[], or null if the
   * hybrid engine is not available (caller should fall back to FTS5).
   */
  async search(
    query: string,
    options: SearchOptions = {}
  ): Promise<SearchResult[] | null> {
    if (!this.ensureEngine() || !this.engine) {
      return null;
    }

    try {
      const results = await this.engine.search(query, {
        limit: options.limit,
        project: options.project,
        currentProject: options.currentProject,
      });

      return toSearchResults(results);
    } catch {
      // Embedding call failed at runtime -- degrade to FTS5
      return null;
    }
  }

  /**
   * Solution-biased hybrid search.
   *
   * Runs hybrid search then applies the same solution-indicator
   * boost logic as SqliteSearchEngine.searchSolutions().
   *
   * Returns community-compatible SearchResult[], or null if the
   * hybrid engine is not available (caller should fall back to FTS5).
   */
  async searchSolutions(
    errorOrProblem: string,
    technology?: string,
    user?: string
  ): Promise<SearchResult[] | null> {
    let query = errorOrProblem;
    if (technology) {
      query = `${technology} ${query}`;
    }

    const results = await this.search(query, { limit: 50, user });
    if (results === null) return null;

    // Apply solution-indicator boost (matches community SqliteSearchEngine.searchSolutions)
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
      confidence:
        topScore > 0 ? Math.round((r.score / topScore) * 100) / 100 : 0,
    }));
  }
}
