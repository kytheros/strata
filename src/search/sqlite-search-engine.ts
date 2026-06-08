/**
 * SQLite-backed search engine using FTS5 for full-text search.
 * Optionally runs hybrid search (FTS5 + vector cosine similarity via RRF)
 * when an embedder and VectorSearch instance are provided.
 * Optionally runs entity graph expansion as a third retrieval channel
 * when an entityStore is provided.
 */

import type { IDocumentStore } from "../storage/interfaces/document-store.js";
import type { FtsSearchResult } from "../storage/interfaces/document-store.js";
import type { IKnowledgeTurnStore, KnowledgeTurnHit, KnowledgeTurnSearchOptions } from "../storage/interfaces/knowledge-turn-store.js";
import { parseQuery, type QueryFilters } from "./query-processor.js";
import type { DocumentChunk } from "../indexing/document-store.js";
import { applyBoosts, applyFilters, reciprocalRankFusion, aggregateToSessionScores, applySessionBoosts, applyTurnRecencyBoost, type RankedResult, type SessionScore } from "./result-ranker.js";
import { CONFIG } from "../config.js";
import type { IVectorSearch, VectorSearchResult } from "../extensions/embeddings/vector-search.js";
import type { EmbeddingProvider } from "../extensions/vector-search/embedding-provider.js";
import type { IEntityStore } from "../storage/interfaces/entity-store.js";
import type { IKnowledgeStore } from "../storage/interfaces/knowledge-store.js";
import type { IEventStore } from "../storage/interfaces/event-store.js";
import { extractEntities } from "../knowledge/entity-extractor.js";
import type { IReranker } from "./reranker/types.js";
import { isCountingQuestion, isTemporalQuestion, isTemporalCurrentStateQuestion } from "./query-classifier.js";
import { resolveModelRouting } from "./model-router.js";
import type { DocumentChunkStore } from "../storage/document-chunk-store.js";
import type { ProvenanceHandle } from "../types/provenance.js";

export interface SearchResult {
  sessionId: string;
  project: string;
  text: string;
  score: number;
  confidence: number;
  timestamp: number;
  toolNames: string[];
  role: "user" | "assistant" | "mixed";
  /** Source of this result: "conversation" (default) or "document" for document chunks,
   *  "chunk" or "turn" for TIR+QDP fused results (TIRQDP-2.1). */
  source?: "conversation" | "document" | "chunk" | "turn";
  /**
   * Structured provenance for this result — populated for knowledge-store results
   * (search_history, find_solutions) where the originating memory row is known.
   * Undefined for raw FTS5 conversation chunks (no knowledge-store row).
   * Added in strata-mcp@2.2.0.
   */
  provenance?: ProvenanceHandle;
}

export interface SearchOptions {
  limit?: number;
  project?: string;
  currentProject?: string;
  includeContext?: boolean;
  user?: string;
  /** Consuming model name for retrieval routing (e.g., 'gemini-2.0-flash', 'gpt-4o') */
  model?: string;
  /**
   * When true, skip the vector-similarity channel entirely (do not call
   * embedder.embed). Used by the LongMemEval benchmark's `--no-vector`
   * flag to run FTS5-only without incurring embedding API costs.
   * Default: false (vector lane runs when embedder + vectorSearch present).
   */
  skipVector?: boolean;
  /** Minimum result score (cosine similarity, 0.0–1.0). Results below are dropped.
   *  Applied by SemanticSearchBridge as a post-filter; the engine itself ignores it. */
  threshold?: number;
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

/** Convert ranked results to SearchResult[] with confidence and source tagging. */
function toSearchResults(ranked: RankedResult[], limit: number, docChunkIds?: Set<string>): SearchResult[] {
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
    source: docChunkIds?.has(r.docId) ? "document" as const : "conversation" as const,
  }));
}

export class SqliteSearchEngine {
  private embedder: EmbeddingProvider | null;
  private vectorSearch: IVectorSearch | null;
  private entityStore: IEntityStore | null;
  private knowledgeStore: IKnowledgeStore | null;
  private eventStore: IEventStore | null = null;
  private reranker: IReranker | null = null;
  private docChunkStore: DocumentChunkStore | null = null;
  private knowledgeTurnStore: IKnowledgeTurnStore | null = null;

  constructor(
    private documentStore: IDocumentStore,
    embedder?: EmbeddingProvider | null,
    vectorSearch?: IVectorSearch | null,
    entityStore?: IEntityStore | null,
    knowledgeStore?: IKnowledgeStore | null
  ) {
    this.embedder = embedder ?? null;
    this.vectorSearch = vectorSearch ?? null;
    this.entityStore = entityStore ?? null;
    this.knowledgeStore = knowledgeStore ?? null;
  }

  /** Inject an event store after construction (lazy initialization pattern). */
  setEventStore(store: IEventStore): void {
    this.eventStore = store;
  }

  /** Inject a reranker after construction (lazy initialization pattern). */
  setReranker(reranker: IReranker): void {
    this.reranker = reranker;
  }

  /** Inject a document chunk store after construction (lazy initialization pattern). */
  setDocumentChunkStore(store: DocumentChunkStore): void {
    this.docChunkStore = store;
  }

  /** Inject a knowledge turn store after construction (lazy initialization pattern). */
  setKnowledgeTurnStore(store: IKnowledgeTurnStore): void {
    this.knowledgeTurnStore = store;
  }

  /** Inject an embedding provider after construction (lazy init). */
  setEmbedder(embedder: EmbeddingProvider | null): void { this.embedder = embedder; }

  /** Inject a vector search after construction (lazy init). */
  setVectorSearch(vs: IVectorSearch | null): void { this.vectorSearch = vs; }

  /**
   * Turn-lane retrieval. Composes `turnStore.searchByQuery` with the
   * classifier-gated `applyTurnRecencyBoost` so every production caller
   * gets the four turn-lane experiments (speaker-prefer, short-session
   * DESC, existential classifier, per-session cap) without remembering
   * to invoke the ranker themselves.
   *
   * When CONFIG.search.denseTurnLane.enabled is true AND an embedder + vectorSearch
   * are present, runs an FTS5+vector RRF hybrid, hydrating vector-only hits before
   * fusion. Degrades to FTS5-only when disabled or no embedder.
   *
   * Returns `[]` if no turn store is attached — callers that legitimately
   * have no turn data can ignore the return value.
   *
   * Spec: 2026-05-25-unified-turn-lane-surface §3.1.
   * Spec: 2026-06-02-dense-turn-lane-design §3.4.
   */
  async searchTurns(
    query: string,
    opts: KnowledgeTurnSearchOptions,
  ): Promise<KnowledgeTurnHit[]> {
    if (!this.knowledgeTurnStore) return [];

    // Widen each lane to limit*3 (mirrors searchAsync), fuse, then slice to limit.
    const wideLimit = opts.limit * 3;
    const ftsHits = await this.knowledgeTurnStore.searchByQuery(query, { ...opts, limit: wideLimit });
    let hits: KnowledgeTurnHit[] = ftsHits.slice(0, opts.limit);

    if (CONFIG.search.denseTurnLane.enabled && this.embedder && this.vectorSearch && !opts.skipVector) {
      try {
        const queryVec = await this.embedder.embed(query, CONFIG.search.denseTurnLane.queryTaskType);
        const vectorHits = await this.vectorSearch.searchTurnEmbeddings(queryVec, wideLimit, {
          userId: opts.userId,
          project: opts.project,
        });
        if (vectorHits.length > 0) {
          // Hydrate: vector-only turn_ids must be fetched before fusion or they
          // vanish at rehydration (the docMap contract from searchAsync).
          const byTurnId = new Map<string, KnowledgeTurnHit>();
          for (const h of ftsHits) byTurnId.set(h.row.turnId, h);
          const missing = vectorHits.map((v) => v.entryId).filter((id) => !byTurnId.has(id));
          if (missing.length > 0) {
            const rows = await this.knowledgeTurnStore.getByIds(missing);
            for (const r of rows) byTurnId.set(r.turnId, { row: r, score: 0 });
          }
          const ftsList = ftsHits.map((h) => ({ docId: h.row.turnId, score: h.score }));
          const vecList = vectorHits.map((v) => ({ docId: v.entryId, score: v.score }));
          const fused = reciprocalRankFusion([ftsList, vecList]);
          const fusedHits: KnowledgeTurnHit[] = [];
          for (const [turnId, score] of [...fused.entries()].sort((a, b) => b[1] - a[1])) {
            const hit = byTurnId.get(turnId);
            if (hit) fusedHits.push({ row: hit.row, score });
          }
          hits = fusedHits.slice(0, opts.limit);
        }
      } catch (err) {
        // Dense lane failed — fall back to the FTS5-only slice already in `hits`.
        console.error("[strata] Dense turn-lane search failed, using FTS5-only:", err);
      }
    }

    if (
      CONFIG.search.turnRecencyBoost.enabled &&
      (opts.forceBoost === true || isTemporalCurrentStateQuestion(query))
    ) {
      return applyTurnRecencyBoost(hits, query, { force: opts.forceBoost === true });
    }
    return hits;
  }

  /**
   * Search conversations using FTS5, optionally fused with vector search via RRF.
   *
   * When both embedder and vectorSearch are available, the query is embedded and
   * vector search runs alongside FTS5. The two ranked lists are merged using
   * reciprocalRankFusion() before applying boosts and filters. If the embedding
   * call fails, search gracefully falls back to FTS5-only results.
   */
  async search(rawQuery: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { text, filters } = parseQuery(rawQuery);

    // Merge explicit project option into filters
    if (options.project && !filters.project) {
      filters.project = options.project;
    }

    const limit = Math.min(options.limit || 20, 100);

    if (!text.trim()) return [];

    // FTS5 search — fetch extra results for post-filtering
    const ftsResults = await this.documentStore.search(text, limit * 3, options.user);

    // Convert FTS results to RankedResult format for the ranker
    // FTS5 bm25() returns negative scores (more negative = more relevant)
    // Normalize to positive scores
    const ranked: RankedResult[] = ftsResults.map((r) => ({
      docId: r.chunk.id,
      score: -r.rank, // Flip sign so higher = better
      doc: r.chunk,
    }));

    // FTS5 search — stored document chunks
    const docChunkIds = new Set<string>();
    if (this.docChunkStore) {
      const docFtsResults = this.docChunkStore.searchFts(text, limit * 2);
      for (const r of docFtsResults) {
        const syntheticDoc: DocumentChunk = {
          id: r.chunkId,
          sessionId: r.documentId,
          project: r.project,
          text: r.content || r.title,
          role: "assistant" as const,
          timestamp: r.createdAt,
          toolNames: [],
          tokenCount: 0,
          messageIndex: 0,
        };
        ranked.push({
          docId: r.chunkId,
          score: -r.rank,
          doc: syntheticDoc,
        });
        docChunkIds.add(r.chunkId);
      }
    }

    // Apply query filters (project, before, after, tool)
    const filtered = applyFilters(ranked, filters);

    // Apply boosts (recency, project match) and dedup per session
    const boosted = applyBoosts(filtered, filters, options.currentProject);

    return toSearchResults(boosted, limit, docChunkIds);
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

    // FTS5 search — conversation chunks
    const ftsResults = await this.documentStore.search(text, limit * 3, options.user);

    const ftsRanked: RankedResult[] = ftsResults.map((r) => ({
      docId: r.chunk.id,
      score: -r.rank,
      doc: r.chunk,
    }));

    // FTS5 search — stored document chunks
    const docChunkIds = new Set<string>();
    if (this.docChunkStore) {
      const docFtsResults = this.docChunkStore.searchFts(text, limit * 2);
      for (const r of docFtsResults) {
        const syntheticDoc: DocumentChunk = {
          id: r.chunkId,
          sessionId: r.documentId,
          project: r.project,
          text: r.content || r.title,
          role: "assistant" as const,
          timestamp: r.createdAt,
          toolNames: [],
          tokenCount: 0,
          messageIndex: 0,
        };
        ftsRanked.push({
          docId: r.chunkId,
          score: -r.rank,
          doc: syntheticDoc,
        });
        docChunkIds.add(r.chunkId);
      }
    }

    // Collect RRF channel lists. FTS5 always present; vector and entity are optional.
    const channels: Array<Array<{ docId: string; score: number }>> = [];
    const docMap = new Map<string, RankedResult>();

    // Channel 1: FTS5 (always — includes both conversation and document chunks)
    const ftsList = ftsRanked
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((r) => ({ docId: r.docId, score: r.score }));
    channels.push(ftsList);
    for (const r of ftsRanked) {
      docMap.set(r.docId, r);
    }

    // Channel 2: Vector similarity (optional)
    if (this.embedder && this.vectorSearch && !options.skipVector) {
      try {
        const queryVec = await this.embedder.embed(text, "CODE_RETRIEVAL_QUERY");
        const project = filters.project || options.currentProject || "";
        let vectorResults = await this.vectorSearch.search(queryVec, project, limit * 3);
        if (vectorResults.length === 0) {
          vectorResults = await this.vectorSearch.searchAll(queryVec, limit * 3);
        }

        // Also search document chunk embeddings
        const docVectorResults = await this.vectorSearch.searchDocumentChunks(queryVec, limit * 2, project || undefined);
        for (const dvr of docVectorResults) {
          vectorResults.push(dvr);
          // Hydrate document chunk vector results into docMap so they survive RRF merge
          if (!docMap.has(dvr.entryId) && this.docChunkStore) {
            const chunkData = this.docChunkStore.getChunkWithMeta(dvr.entryId);
            if (chunkData) {
              const syntheticDoc: DocumentChunk = {
                id: chunkData.chunkId,
                sessionId: chunkData.documentId,
                project: chunkData.project,
                text: chunkData.content || chunkData.title,
                role: "assistant" as const,
                timestamp: chunkData.createdAt,
                toolNames: [],
                tokenCount: 0,
                messageIndex: 0,
              };
              docMap.set(dvr.entryId, { docId: dvr.entryId, score: 0, doc: syntheticDoc });
              docChunkIds.add(dvr.entryId);
            }
          }
        }

        if (vectorResults.length > 0) {
          channels.push(vectorResults.map((r) => ({ docId: r.entryId, score: r.score })));
        }
      } catch (err) {
        // Embedding failed — continue without vector channel
        console.error("[strata] Vector search failed, continuing with other channels:", err);
      }
    }

    // Channel 3: Knowledge-based session expansion (primary) or entity graph (fallback)
    if (this.knowledgeStore) {
      try {
        const knowledgeResults = await this.expandViaKnowledge(text, ftsRanked, limit * 2);
        if (knowledgeResults.length > 0) {
          channels.push(knowledgeResults);
        }
      } catch (err) {
        console.error("[strata] Knowledge expansion failed, continuing:", err);
      }
    } else if (this.entityStore) {
      try {
        const entityResults = await this.expandViaEntities(text, ftsRanked, limit * 2);
        if (entityResults.length > 0) {
          channels.push(entityResults);
        }
      } catch (err) {
        console.error("[strata] Entity expansion failed, continuing:", err);
      }
    }

    // If we only have FTS5, skip RRF overhead
    if (channels.length === 1) {
      const filtered = applyFilters(ftsRanked, filters);
      const boosted = applyBoosts(filtered, filters, options.currentProject);
      return toSearchResults(boosted, limit, docChunkIds);
    }

    // RRF fusion across all available channels
    const fusedScores = reciprocalRankFusion(channels);

    const merged: RankedResult[] = [];
    for (const [docId, score] of fusedScores) {
      const existing = docMap.get(docId);
      if (existing) {
        merged.push({ ...existing, score });
      }
    }

    merged.sort((a, b) => b.score - a.score);

    const filtered = applyFilters(merged, filters);
    const boosted = applyBoosts(filtered, filters, options.currentProject);

    return toSearchResults(boosted, limit, docChunkIds);
  }

  /**
   * Session-level search: aggregate chunk scores into session-level DCG scores.
   *
   * Instead of returning the single best chunk per session (like searchAsync),
   * this method:
   * 1. Fetches a wider candidate pool of chunks (turnRetrievalK)
   * 2. Runs RRF fusion and filtering (same channels as searchAsync)
   * 3. Aggregates chunks into session-level DCG scores
   * 4. Applies session-level boosts (recency, project, importance)
   * 5. Optionally loads full session text for top-K sessions
   *
   * Returns SearchResult[] where each result represents an entire session.
   */
  async searchSessionLevel(
    rawQuery: string,
    options: SearchOptions & {
      sessionK?: number;
      /**
       * When true, skip the cross-encoder reranker for this call.
       *
       * The reranker can demote gold sessions to positions >20 for
       * knowledge-update questions (and others where FTS/DCG already
       * ranks the gold high). Setting this flag restores the pure DCG
       * ordering used by the prod-consumer-parity benchmark arm that
       * achieves 98.7% recall@20.
       *
       * Default: false (reranker runs when set on the engine, per CONFIG.reranker.enabled).
       */
      skipReranker?: boolean;
    } = {}
  ): Promise<SearchResult[]> {
    const { text, filters } = parseQuery(rawQuery);

    if (options.project && !filters.project) {
      filters.project = options.project;
    }

    // Model-aware retrieval routing: override sessionK and reranker behavior
    const modelParams = resolveModelRouting(options.model);
    const sessionK = options.sessionK ?? modelParams?.sessionTopK ?? CONFIG.session.sessionTopK;
    // Use a wider candidate pool for session aggregation
    const candidateLimit = CONFIG.session.turnRetrievalK;

    if (!text.trim()) return [];

    // ---- Retrieve candidate chunks (same channel logic as searchAsync) ----

    const ftsResults = await this.documentStore.search(text, candidateLimit * 3, options.user);

    const ftsRanked: RankedResult[] = ftsResults.map((r) => ({
      docId: r.chunk.id,
      score: -r.rank,
      doc: r.chunk,
    }));

    // FTS5 search — stored document chunks
    const docChunkIds = new Set<string>();
    if (this.docChunkStore) {
      const docFtsResults = this.docChunkStore.searchFts(text, candidateLimit * 2);
      for (const r of docFtsResults) {
        const syntheticDoc: DocumentChunk = {
          id: r.chunkId,
          sessionId: r.documentId,
          project: r.project,
          text: r.content || r.title,
          role: "assistant" as const,
          timestamp: r.createdAt,
          toolNames: [],
          tokenCount: 0,
          messageIndex: 0,
        };
        ftsRanked.push({
          docId: r.chunkId,
          score: -r.rank,
          doc: syntheticDoc,
        });
        docChunkIds.add(r.chunkId);
      }
    }

    const channels: Array<Array<{ docId: string; score: number }>> = [];
    const docMap = new Map<string, RankedResult>();

    // Channel 1: FTS5 (always — includes both conversation and document chunks)
    const ftsList = ftsRanked
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((r) => ({ docId: r.docId, score: r.score }));
    channels.push(ftsList);
    for (const r of ftsRanked) {
      docMap.set(r.docId, r);
    }

    // Channel 2: Vector similarity (optional)
    if (this.embedder && this.vectorSearch) {
      try {
        const queryVec = await this.embedder.embed(text, "CODE_RETRIEVAL_QUERY");
        const project = filters.project || options.currentProject || "";
        let vectorResults = await this.vectorSearch.search(queryVec, project, candidateLimit * 3);
        if (vectorResults.length === 0) {
          vectorResults = await this.vectorSearch.searchAll(queryVec, candidateLimit * 3);
        }

        // Also search document chunk embeddings
        const docVectorResults = await this.vectorSearch.searchDocumentChunks(queryVec, candidateLimit * 2, project || undefined);
        for (const dvr of docVectorResults) {
          vectorResults.push(dvr);
          // Hydrate document chunk vector results into docMap so they survive RRF merge
          if (!docMap.has(dvr.entryId) && this.docChunkStore) {
            const chunkData = this.docChunkStore.getChunkWithMeta(dvr.entryId);
            if (chunkData) {
              const syntheticDoc: DocumentChunk = {
                id: chunkData.chunkId,
                sessionId: chunkData.documentId,
                project: chunkData.project,
                text: chunkData.content || chunkData.title,
                role: "assistant" as const,
                timestamp: chunkData.createdAt,
                toolNames: [],
                tokenCount: 0,
                messageIndex: 0,
              };
              docMap.set(dvr.entryId, { docId: dvr.entryId, score: 0, doc: syntheticDoc });
              docChunkIds.add(dvr.entryId);
            }
          }
        }

        if (vectorResults.length > 0) {
          channels.push(vectorResults.map((r) => ({ docId: r.entryId, score: r.score })));
        }
      } catch (err) {
        console.error("[strata] Vector search failed, continuing with other channels:", err);
      }
    }

    // Channel 3: Knowledge/entity expansion for chunk-level RRF
    // (still used for chunk ranking — helps even within session scoring)
    if (this.knowledgeStore) {
      try {
        const knowledgeResults = await this.expandViaKnowledge(text, ftsRanked, candidateLimit * 2);
        if (knowledgeResults.length > 0) {
          channels.push(knowledgeResults);
        }
      } catch (err) {
        console.error("[strata] Knowledge expansion failed, continuing:", err);
      }
    } else if (this.entityStore) {
      try {
        const entityResults = await this.expandViaEntities(text, ftsRanked, candidateLimit * 2);
        if (entityResults.length > 0) {
          channels.push(entityResults);
        }
      } catch (err) {
        console.error("[strata] Entity expansion failed, continuing:", err);
      }
    }

    // ---- Session-level knowledge/entity signals (INDEPENDENT of FTS candidates) ----
    // These bypass the chunk-level FTS restriction and feed directly into session scoring.
    // This is the coverage gap fix: sessions found via knowledge/entity but missed by
    // document FTS5 can now surface in the final results.
    const knowledgeSessionScores = new Map<string, number>();
    const entitySessionScores = new Map<string, number>();

    if (this.knowledgeStore) {
      try {
        const kEntries = await this.knowledgeStore.search(text);
        for (const entry of kEntries) {
          knowledgeSessionScores.set(
            entry.sessionId,
            (knowledgeSessionScores.get(entry.sessionId) ?? 0) + 1
          );
        }
      } catch { /* non-blocking */ }
    }

    if (this.entityStore) {
      try {
        const queryEntities = extractEntities(text);
        for (const e of queryEntities) {
          const entity = await this.entityStore.findByName(e.canonicalName);
          if (!entity) continue;
          const linked = await this.entityStore.getKnowledgeForEntity(entity.id);
          for (const ke of linked) {
            entitySessionScores.set(
              ke.sessionId,
              (entitySessionScores.get(ke.sessionId) ?? 0) + 1
            );
          }
          const relations = await this.entityStore.getRelationsFor(entity.id);
          for (const rel of relations) {
            const relatedId = rel.source_entity_id === entity.id
              ? rel.target_entity_id : rel.source_entity_id;
            const relatedKnowledge = await this.entityStore.getKnowledgeForEntity(relatedId);
            for (const rk of relatedKnowledge) {
              entitySessionScores.set(
                rk.sessionId,
                (entitySessionScores.get(rk.sessionId) ?? 0) + 0.5
              );
            }
          }
        }
      } catch { /* non-blocking */ }
    }

    // Event-based session signals (SVO events bridge vocabulary gaps)
    const eventSessionScores = new Map<string, number>();
    if (this.eventStore && CONFIG.events.enabled) {
      try {
        const matchingEvents = await this.eventStore.search(text, 50);
        for (const event of matchingEvents) {
          eventSessionScores.set(
            event.sessionId,
            (eventSessionScores.get(event.sessionId) ?? 0) + 1
          );
        }
      } catch { /* non-blocking */ }
    }

    // ---- Fuse and filter ----

    let rankedChunks: RankedResult[];

    if (channels.length === 1) {
      // FTS5 only — skip RRF overhead
      rankedChunks = applyFilters(ftsRanked, filters);
      rankedChunks.sort((a, b) => b.score - a.score);
    } else {
      // RRF fusion across all available channels
      const fusedScores = reciprocalRankFusion(channels);

      const merged: RankedResult[] = [];
      for (const [docId, score] of fusedScores) {
        const existing = docMap.get(docId);
        if (existing) {
          merged.push({ ...existing, score });
        }
      }
      merged.sort((a, b) => b.score - a.score);

      rankedChunks = applyFilters(merged, filters);
    }

    // ---- Session-level aggregation ----

    const sessionScores = aggregateToSessionScores(rankedChunks);

    // Inject knowledge/entity session signals into session scores.
    // Sessions found via knowledge/entity but NOT via FTS get a new SessionScore entry.
    // Sessions already in the list get their dcgScore boosted.
    const kBoostExisting = CONFIG.session.knowledgeBoostExisting;
    const kBoostNew = CONFIG.session.knowledgeBoostNew;
    const eBoostExisting = CONFIG.session.entityBoostExisting;

    for (const [sessionId, kScore] of knowledgeSessionScores) {
      const existing = sessionScores.find(s => s.sessionId === sessionId);
      if (existing) {
        existing.dcgScore *= (1 + kBoostExisting * Math.min(kScore, 5));
      } else if (kBoostNew > 0) {
        // NEW session not in FTS results — inject with knowledge-only score
        sessionScores.push({
          sessionId,
          dcgScore: kBoostNew * Math.min(kScore, 5),
          chunks: [],
          bestChunk: ftsRanked[0] ?? rankedChunks[0], // placeholder for metadata
          sumScore: 0,
          chunkCount: 0,
        });
      }
    }

    for (const [sessionId, eScore] of entitySessionScores) {
      const existing = sessionScores.find(s => s.sessionId === sessionId);
      if (existing) {
        existing.dcgScore *= (1 + eBoostExisting * Math.min(eScore, 5));
      }
    }

    // Event boost: similar to knowledge/entity boost
    const eBoostEvents = 0.05;
    for (const [sessionId, evScore] of eventSessionScores) {
      const existing = sessionScores.find(s => s.sessionId === sessionId);
      if (existing) {
        existing.dcgScore *= (1 + eBoostEvents * Math.min(evScore, 10));
      }
    }

    let boostedSessions = applySessionBoosts(
      sessionScores,
      filters,
      options.currentProject,
      undefined, // now (use default)
      text       // query for recency boost detection
    );

    // ---- Load full session text for reranking + result building ----
    // Full text must be loaded BEFORE the reranker so the cross-encoder scores
    // complete sessions (~1600 tokens), not bestChunk fragments (~160 tokens).

    const loadFullSessions = options.includeContext !== false;
    const sessionTextMap = new Map<string, string>();

    // Track which sessionIds correspond to stored documents (for source tagging)
    const docSessionIds = new Set<string>();
    for (const chunk of rankedChunks) {
      if (docChunkIds.has(chunk.docId)) {
        docSessionIds.add(chunk.doc.sessionId);
      }
    }

    if (loadFullSessions) {
      const candidateCount = this.reranker && CONFIG.reranker.enabled
        ? Math.min(CONFIG.reranker.candidateCount, boostedSessions.length)
        : sessionK;
      const sessionsToLoad = boostedSessions.slice(0, candidateCount);

      for (const session of sessionsToLoad) {
        // Document "sessions" use documentId — load from document chunk store
        if (docSessionIds.has(session.sessionId) && this.docChunkStore) {
          try {
            const docChunks = this.docChunkStore.getChunks(session.sessionId);
            if (docChunks.length > 0) {
              docChunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
              sessionTextMap.set(session.sessionId, docChunks.map((c) => c.content || "").join("\n\n"));
            }
          } catch {
            // Fall back to bestChunk text
          }
        } else {
          try {
            const allChunks = await this.documentStore.getBySession(session.sessionId);
            if (allChunks.length > 0) {
              allChunks.sort((a, b) => a.messageIndex - b.messageIndex);
              sessionTextMap.set(session.sessionId, allChunks.map((c) => c.text).join("\n\n"));
            }
          } catch {
            // Fall back to bestChunk text (set below)
          }
        }
      }
    }

    // Helper: get full text for a session, falling back to bestChunk
    const getSessionText = (session: SessionScore): string =>
      sessionTextMap.get(session.sessionId) ?? session.bestChunk.doc.text;

    // ---- Cross-encoder reranking (Phase 2b) ----
    // Now uses full session text instead of bestChunk fragment.

    // Skip reranker for counting/temporal queries -- benchmark validated -6pp/-20pp regression
    // Also honor the caller's explicit skipReranker flag (used by the deep path to match
    // the prod-consumer-parity benchmark arm that achieves 98.7% recall@20 without reranker).
    const skipReranker = options.skipReranker ||
                         (CONFIG.reranker.skipForCounting && isCountingQuestion(text)) ||
                         (CONFIG.reranker.skipForTemporal && isTemporalQuestion(text));
    // Model routing can disable the reranker for small-context models
    const modelSkipReranker = modelParams ? !modelParams.useReranker : false;

    if (this.reranker && CONFIG.reranker.enabled && !skipReranker && !modelSkipReranker && boostedSessions.length > 1) {
      const candidateCount = Math.min(
        CONFIG.reranker.candidateCount,
        boostedSessions.length
      );
      const candidates = boostedSessions.slice(0, candidateCount);

      const rerankDocs = candidates.map((s) => ({
        id: s.sessionId,
        text: getSessionText(s),
      }));

      const rerankResults = await this.reranker.rerank({
        query: text,
        documents: rerankDocs,
        topN: sessionK,
      });

      if (rerankResults) {
        const alpha = CONFIG.reranker.alpha;
        const rerankMap = new Map(
          rerankResults.map((r) => [r.id, r.relevanceScore])
        );

        // Normalize DCG scores to [0,1] for blending
        const maxDcg = candidates[0]?.dcgScore || 1;

        for (const session of candidates) {
          const rerankScore = rerankMap.get(session.sessionId);
          if (
            rerankScore !== undefined &&
            rerankScore >= CONFIG.reranker.minRelevanceScore
          ) {
            const normDcg = maxDcg > 0 ? session.dcgScore / maxDcg : 0;
            session.dcgScore = alpha * rerankScore + (1 - alpha) * normDcg;
          }
        }

        // Re-sort by blended score
        candidates.sort((a, b) => b.dcgScore - a.dcgScore);
        boostedSessions = candidates;
      }
    }

    const topSessions = boostedSessions.slice(0, sessionK);

    // ---- Build results ----

    const results: SearchResult[] = [];

    for (const session of topSessions) {
      const resultText = getSessionText(session);

      // Compute confidence relative to top session
      const topDcg = topSessions[0]?.dcgScore ?? 1;
      const confidence = topDcg > 0
        ? Math.round((session.dcgScore / topDcg) * 100) / 100
        : 0;

      results.push({
        sessionId: session.sessionId,
        project: session.bestChunk.doc.project,
        text: resultText,
        score: session.dcgScore,
        confidence,
        timestamp: session.bestChunk.doc.timestamp,
        toolNames: session.bestChunk.doc.toolNames,
        role: session.bestChunk.doc.role,
        source: docSessionIds.has(session.sessionId) ? "document" as const : "conversation" as const,
      });
    }

    return results;
  }

  /**
   * Expand search results via knowledge store lookup.
   *
   * Strategy: search the knowledge store for entries matching the query,
   * then use sessionIds from matching entries to boost document chunks
   * from those sessions. Treats knowledge entries as retrieval keys for
   * session discovery — a knowledge entry mentioning "Golden Retriever"
   * will surface the session where the user talked about their dog.
   *
   * Returns a ranked list suitable for RRF fusion. Score = number of
   * matching knowledge entries per session.
   */
  private async expandViaKnowledge(
    query: string,
    ftsResults: RankedResult[],
    limit: number
  ): Promise<Array<{ docId: string; score: number }>> {
    if (!this.knowledgeStore) return [];

    // Primary: vector cosine search on knowledge entries (bridges vocabulary gaps)
    // Fallback: LIKE keyword search
    let matchingEntries;
    if (this.embedder && this.vectorSearch) {
      try {
        const queryVec = await this.embedder.embed(query, "RETRIEVAL_QUERY");
        const vectorResults = await this.vectorSearch.searchAll(queryVec, limit);
        if (vectorResults.length > 0) {
          // Map vector results to knowledge entries
          const entries = [];
          for (const vr of vectorResults) {
            const entry = await this.knowledgeStore.getEntry(vr.entryId);
            if (entry) entries.push(entry);
          }
          matchingEntries = entries;
        }
      } catch {
        // Vector search failed — fall through to LIKE
      }
    }

    if (!matchingEntries || matchingEntries.length === 0) {
      matchingEntries = await this.knowledgeStore.search(query);
    }

    if (matchingEntries.length === 0) return [];

    // Tally scores per session — more matching entries = higher score
    const sessionScores = new Map<string, number>();
    for (const entry of matchingEntries) {
      sessionScores.set(
        entry.sessionId,
        (sessionScores.get(entry.sessionId) || 0) + 1
      );
    }

    // Map session scores to FTS document chunks.
    // For sessions found via knowledge but not in FTS results,
    // we only boost sessions already in the FTS candidate set.
    // RRF will promote these sessions above FTS-only results.
    const ftsSessionMap = new Map<string, RankedResult>();
    for (const r of ftsResults) {
      if (!ftsSessionMap.has(r.doc.sessionId)) {
        ftsSessionMap.set(r.doc.sessionId, r);
      }
    }

    const results: Array<{ docId: string; score: number }> = [];
    for (const [sessionId, score] of sessionScores) {
      const ftsDoc = ftsSessionMap.get(sessionId);
      if (ftsDoc) {
        results.push({ docId: ftsDoc.docId, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * Expand search results via entity graph traversal.
   *
   * Strategy: extract entities from query AND from top FTS results (spreading
   * activation), then traverse the entity graph to find document chunks from
   * sessions mentioning related entities.
   *
   * Returns a ranked list suitable for RRF fusion. Score = number of entity
   * links pointing to each session (more links = more relevant).
   */
  private async expandViaEntities(
    query: string,
    ftsResults: RankedResult[],
    limit: number
  ): Promise<Array<{ docId: string; score: number }>> {
    if (!this.entityStore) return [];

    // 1. Extract entities from the query only
    //    Spreading activation (extracting from FTS results) is disabled because
    //    it pulls in irrelevant tech entities from session content that drown
    //    out the actual evidence sessions via RRF reranking.
    const queryEntities = extractEntities(query);

    // 2. Deduplicate by canonical name
    const entityNames = new Set<string>();
    for (const e of queryEntities) {
      entityNames.add(e.canonicalName);
    }

    if (entityNames.size === 0) return [];

    // 4. Look up each entity and traverse 1-hop relations
    const sessionScores = new Map<string, number>();

    for (const name of entityNames) {
      const entity = await this.entityStore.findByName(name);
      if (!entity) continue;

      // Direct: knowledge entries linked to this entity
      const linkedKnowledge = await this.entityStore.getKnowledgeForEntity(entity.id);
      for (const ke of linkedKnowledge) {
        sessionScores.set(ke.sessionId, (sessionScores.get(ke.sessionId) || 0) + 1);
      }

      // 1-hop: traverse relations to find related entities' sessions
      const relations = await this.entityStore.getRelationsFor(entity.id);
      for (const rel of relations) {
        const relatedId = rel.source_entity_id === entity.id
          ? rel.target_entity_id
          : rel.source_entity_id;
        const relatedKnowledge = await this.entityStore.getKnowledgeForEntity(relatedId);
        for (const ke of relatedKnowledge) {
          // Related entities get half the score of direct links
          sessionScores.set(ke.sessionId, (sessionScores.get(ke.sessionId) || 0) + 0.5);
        }
      }
    }

    if (sessionScores.size === 0) return [];

    // 5. Find document chunks from entity-linked sessions
    //    Use FTS results as a doc lookup — match by sessionId
    const ftsSessionMap = new Map<string, RankedResult>();
    for (const r of ftsResults) {
      if (!ftsSessionMap.has(r.doc.sessionId)) {
        ftsSessionMap.set(r.doc.sessionId, r);
      }
    }

    // For sessions found via entities but not in FTS results,
    // we need to do a lightweight lookup. For now, only boost
    // sessions that are already in the FTS candidate set.
    // This still helps because RRF will promote these sessions
    // above FTS-only results that lack entity support.
    const results: Array<{ docId: string; score: number }> = [];
    for (const [sessionId, score] of sessionScores) {
      const ftsDoc = ftsSessionMap.get(sessionId);
      if (ftsDoc) {
        results.push({ docId: ftsDoc.docId, score });
      }
    }

    // Sort by entity link score descending
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * Browse sessions within a date range (no text query required).
   * Returns one result per session, ordered by timestamp descending.
   */
  async searchByDateRange(
    afterMs: number,
    beforeMs: number,
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    const limit = Math.min(options.limit || 20, 100);
    // Fetch extra chunks so we can deduplicate per session
    const chunks = await this.documentStore.searchByDateRange(afterMs, beforeMs, limit * 3, options.user);

    // Deduplicate: keep most recent chunk per session
    const bestPerSession = new Map<string, DocumentChunk>();
    for (const chunk of chunks) {
      const existing = bestPerSession.get(chunk.sessionId);
      if (!existing || chunk.timestamp > existing.timestamp) {
        bestPerSession.set(chunk.sessionId, chunk);
      }
    }

    // Apply project filter if specified
    let sessions = [...bestPerSession.values()];
    if (options.project) {
      sessions = sessions.filter(c => c.project.toLowerCase().includes(options.project!.toLowerCase()));
    }

    // Sort by timestamp descending (most recent first)
    sessions.sort((a, b) => b.timestamp - a.timestamp);

    return sessions.slice(0, limit).map((chunk, i) => ({
      sessionId: chunk.sessionId,
      project: chunk.project,
      text: chunk.text,
      score: sessions.length - i, // Ordinal score
      confidence: 1.0,
      timestamp: chunk.timestamp,
      toolNames: chunk.toolNames,
      role: chunk.role,
    }));
  }

  /**
   * Search specifically for error/solution patterns.
   */
  async searchSolutions(
    errorOrProblem: string,
    technology?: string,
    user?: string
  ): Promise<SearchResult[]> {
    let query = errorOrProblem;
    if (technology) {
      query = `${technology} ${query}`;
    }

    const results = await this.search(query, { limit: 50, user });

    return this.applySolutionBoost(results);
  }

  /**
   * Async version of searchSolutions that supports hybrid FTS5 + vector search.
   * Falls back to FTS5-only when no embedder is configured or embedding fails.
   */
  async searchSolutionsAsync(
    errorOrProblem: string,
    technology?: string,
    user?: string
  ): Promise<SearchResult[]> {
    let query = errorOrProblem;
    if (technology) {
      query = `${technology} ${query}`;
    }

    const results = await this.searchAsync(query, { limit: 50, user });

    return this.applySolutionBoost(results);
  }

  /**
   * Apply solution-word boosting and re-rank results.
   * Shared by both searchSolutions() and searchSolutionsAsync().
   */
  private applySolutionBoost(results: SearchResult[]): SearchResult[] {
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
