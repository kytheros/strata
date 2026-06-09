import type Database from "better-sqlite3";
import type { SqliteSearchEngine, SearchResult, SearchOptions } from "../search/sqlite-search-engine.js";
import type { IKnowledgeStore } from "../storage/interfaces/knowledge-store.js";
import type { IKnowledgeTurnStore } from "../storage/interfaces/knowledge-turn-store.js";
import { extractProjectName } from "../utils/path-encoder.js";
import { ResponseFormat } from "../utils/response-format.js";
import { CompactSerializer } from "../utils/compact-serializer.js";
import { truncatePreview } from "../utils/response.js";
import { CONFIG } from "../config.js";
import { recordGap, getGapOccurrences } from "../search/evidence-gaps.js";
import { parseDate } from "../search/query-processor.js";
import { knowledgeEntryToSearchResult } from "../search/knowledge-to-search-result.js";
import { formatProvenanceHandle } from "../utils/format-provenance.js";
import { fuseCommunityLanes } from "../search/recall-fusion-community.js";
import type { CommunityChunkResult } from "../search/recall-fusion-community.js";
import { recallQdpCommunity } from "../search/recall-qdp-community.js";
import { fuseDenseTurnLane } from "../search/dense-turn-fusion.js";
import { deduplicateToSessions } from "../search/dedupe-to-sessions.js";

/**
 * Search the knowledge table for stored memories matching a query.
 * Returns results in SearchResult format so they merge with document results.
 */
function searchKnowledge(db: Database.Database, query: string, options: SearchOptions): SearchResult[] {
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  if (terms.length === 0) return [];

  // Build WHERE clause: all terms must appear in summary or details
  const conditions = terms.map(() => "(LOWER(summary || ' ' || details) LIKE ?)");
  const params: unknown[] = terms.map(t => `%${t}%`);

  let sql = `SELECT id, type, project, session_id, timestamp, summary, details, tags, importance
    FROM knowledge WHERE ${conditions.join(" AND ")}`;

  if (options.project) {
    sql += " AND project = ?";
    params.push(options.project);
  }
  if (options.user) {
    sql += " AND user = ?";
    params.push(options.user);
  }

  sql += " ORDER BY importance DESC, timestamp DESC LIMIT ?";
  params.push(Math.min(options.limit ?? 20, 100));

  try {
    const rows = db.prepare(sql).all(...params) as Array<{
      id: string; type: string; project: string; session_id: string;
      timestamp: number; summary: string; details: string; tags: string;
      importance: number | null;
    }>;

    return rows.map(r => {
      const text = r.details && r.details !== r.summary
        ? `[${r.type}] ${r.summary}\n${r.details}`
        : `[${r.type}] ${r.summary}`;
      const tags = r.tags ? JSON.parse(r.tags) as string[] : [];

      // Score: importance-based with a boost for stored memories
      const baseScore = (r.importance ?? 0.5) * 10;
      return {
        sessionId: r.session_id || "knowledge",
        project: r.project,
        text,
        score: baseScore,
        confidence: Math.min(baseScore / 10, 1),
        timestamp: r.timestamp,
        toolNames: tags.length > 0 ? [`tags:${tags.join(",")}`] : [],
        role: "assistant" as const,
      };
    });
  } catch {
    return [];
  }
}

/** Map confidence value to a display band label. */
function confidenceBand(c: number): string {
  if (c >= CONFIG.search.confidenceHighThreshold) return "high";
  if (c >= CONFIG.search.confidenceMediumThreshold) return "medium";
  return "low";
}

/** Check if the top result is below the low-confidence absolute score threshold. */
function isLowConfidence(results: SearchResult[]): boolean {
  return results.length > 0 && results[0].score < CONFIG.search.lowConfidenceThreshold;
}

export interface SearchHistoryArgs {
  query: string;
  project?: string;
  limit?: number;
  include_context?: boolean;
  format?: string;
  user?: string;
  max_chars?: number;
  after_date?: string;
  before_date?: string;
  /** Consuming model name for retrieval routing (e.g., 'gemini-2.0-flash', 'gpt-4o') */
  model?: string;
  /**
   * Per-query retrieval strategy override.
   *
   * - "auto"   (default / omitted): reads CONFIG.search.useTirQdp, current behavior.
   * - "tirqdp": force TIR+QDP turn-level retrieval for this query, even when
   *             CONFIG.search.useTirQdp is false. Opt-in bridge to #13.
   *             Falls back to legacy gracefully when turnStore is unavailable.
   * - "legacy": force BM25+chunk lane for this query, even when
   *             CONFIG.search.useTirQdp is true. Useful for temporal/multi-session
   *             queries where TIR+QDP underperforms (see 2026-05-11 stratified eval).
   * - "deep": session-level retrieval (session-scoring + cross-encoder reranker
   *   + event signals) via searchSessionLevel, then dense-turn fusion. Reproduces
   *   the benchmark's high-accuracy read path. Opt-in; heavier per query (loads
   *   full session text, runs the reranker). SQLite backend (Phase 1).
   */
  retrieval_strategy?: "auto" | "tirqdp" | "legacy" | "deep";
}

/**
 * Resolve the effective retrieval strategy for a query.
 *
 * "auto" or omitted → defer to CONFIG.search.useTirQdp (zero behavior change).
 * "tirqdp"          → force TIR+QDP regardless of config flag.
 * "legacy"          → force legacy BM25+chunk regardless of config flag.
 */
function resolveRetrievalStrategy(
  param: SearchHistoryArgs["retrieval_strategy"],
  configFlag: boolean,
): "tirqdp" | "legacy" {
  if (param === "tirqdp") return "tirqdp";
  if (param === "legacy") return "legacy";
  // "auto" or undefined: fall back to global config
  return configFlag ? "tirqdp" : "legacy";
}

/**
 * Normalize search results into serializable records.
 * When a result carries source: "turn" | "chunk" (TIR+QDP path), the field is
 * included in the output so downstream consumers and tests can verify the lane.
 */
function toRecords(results: SearchResult[], maxChars: number): Record<string, unknown>[] {
  return results.map((r) => {
    const record: Record<string, unknown> = {
      project: extractProjectName(r.project),
      sessionId: r.sessionId,
      date: r.timestamp ? new Date(r.timestamp).toLocaleDateString() : "unknown",
      score: Math.round(r.score * 100) / 100,
      confidence: r.confidence,
      role: r.role,
      tools: r.toolNames.length > 0 ? r.toolNames.join(", ") : "",
      snippet: truncatePreview(r.text, 200),
      text: r.text.length > maxChars ? r.text.slice(0, maxChars) + "..." : r.text,
    };
    // Include source discriminator when present (TIR+QDP fused results carry "turn" | "chunk")
    if (r.source === "turn" || r.source === "chunk") {
      record.source = r.source;
    }
    return record;
  });
}

/**
 * Build the recommended-agent context block: chronological (oldest→newest),
 * dated, numbered notes with relevance-rank chrome stripped. Dedup-to-sessions
 * is on by default (kill-switch STRATA_AGENT_FORMAT_DEDUPE=off for the
 * validation A/B per the spec §4.3). Pure formatting over SearchResult[] →
 * identical across SQLite/Postgres backends.
 */
export function buildAgentContext(results: SearchResult[], query: string, maxChars: number): string {
  if (results.length === 0) {
    return `No relevant memory found for "${query}".`;
  }
  const dedupe = process.env.STRATA_AGENT_FORMAT_DEDUPE !== "off";
  const entries = dedupe ? deduplicateToSessions(results) : results.slice();
  // Chronological: oldest first; unknown/NaN timestamps sort last.
  entries.sort((a, b) => {
    const at = Number.isFinite(a.timestamp) ? a.timestamp : Number.POSITIVE_INFINITY;
    const bt = Number.isFinite(b.timestamp) ? b.timestamp : Number.POSITIVE_INFINITY;
    return at - bt;
  });
  const lines: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const r = entries[i];
    const d = new Date(r.timestamp);
    const dateStr = isNaN(d.getTime()) ? "Unknown date" : d.toISOString().split("T")[0];
    const text = r.text.length > maxChars ? r.text.slice(0, maxChars) + "..." : r.text;
    lines.push(`Note ${i + 1} (${dateStr}):\n${text}\n`);
  }
  return lines.join("\n");
}

/**
 * Search knowledge entries via the IKnowledgeStore interface (D1-compatible).
 * Converts KnowledgeEntry[] to SearchResult[] format.
 */
async function searchKnowledgeViaStore(
  store: IKnowledgeStore,
  query: string,
  options: SearchOptions
): Promise<SearchResult[]> {
  try {
    const entries = await store.search(query, options.project, options.user);
    return entries.map(knowledgeEntryToSearchResult);
  } catch {
    return [];
  }
}

export async function handleSearchHistory(
  engine: SqliteSearchEngine,
  args: SearchHistoryArgs,
  db?: Database.Database,
  asyncSearch?: (query: string, options: SearchOptions) => Promise<SearchResult[]>,
  knowledgeStore?: IKnowledgeStore,
  /** Optional turn store — activates the dense turn-lane (CONFIG.search.denseTurnLane.enabled,
   *  default ON when a provider is present) and the legacy TIR+QDP lane
   *  (CONFIG.search.useTirQdp). Bypassed when retrieval_strategy:"legacy" is set. */
  turnStore?: IKnowledgeTurnStore
): Promise<string> {
  const maxChars = Math.min(Math.max(args.max_chars ?? 2500, 1), 10000);

  // If explicit date params provided, inject them as inline filters
  let query = args.query;
  if (args.after_date && !query.includes("after:")) {
    query += ` after:${args.after_date}`;
  }
  if (args.before_date && !query.includes("before:")) {
    query += ` before:${args.before_date}`;
  }

  const searchOptions: SearchOptions = {
    limit: args.limit,
    project: args.project,
    includeContext: args.include_context,
    user: args.user,
    model: args.model,
  };

  // Check if there is an actual text query (stripping inline filter directives)
  const hasTextQuery = query
    .replace(/\b(project|before|after|tool|branch):\S+/gi, "")
    .trim().length > 0;

  // Date-only browsing: no text query, just date range
  if (!hasTextQuery && (args.after_date || args.before_date)) {
    const afterMs = args.after_date ? parseDate(args.after_date) : 0;
    const beforeMs = args.before_date ? parseDate(args.before_date) : Date.now();

    const dateResults = await engine.searchByDateRange(afterMs, beforeMs, searchOptions);

    if (dateResults.length === 0) {
      return `No sessions found in the specified date range.`;
    }

    const records = toRecords(dateResults, maxChars);
    const format = (args.format as ResponseFormat) || ResponseFormat.STANDARD;

    if (format === ResponseFormat.AGENT) {
      return buildAgentContext(dateResults, args.query, maxChars);
    }

    if (format === ResponseFormat.CONCISE) {
      const serializer = new CompactSerializer("results");
      return `Found ${dateResults.length} session(s) in date range:\n\n` +
        serializer.serialize(records, { format });
    }

    if (format === ResponseFormat.DETAILED) {
      const serializer = new CompactSerializer("results");
      return serializer.serialize(records, { format });
    }

    // Standard format
    const lines: string[] = [`Found ${dateResults.length} session(s) in date range:\n`];
    for (const r of dateResults) {
      const projectName = extractProjectName(r.project);
      const date = r.timestamp
        ? new Date(r.timestamp).toLocaleDateString()
        : "unknown date";
      const toolInfo =
        r.toolNames.length > 0 ? ` [tools: ${r.toolNames.join(", ")}]` : "";
      lines.push(`--- ${projectName} (${date})${toolInfo} ---`);
      const text = r.text.length > maxChars ? r.text.slice(0, maxChars) + "..." : r.text;
      lines.push(text);
      lines.push("");
    }
    return lines.join("\n");
  }

  let results: SearchResult[];

  const strategy = resolveRetrievalStrategy(args.retrieval_strategy, CONFIG.search.useTirQdp);

  // When tirqdp is forced but turnStore is unavailable, fall back to legacy and note it.
  const effectiveTirqdp = strategy === "tirqdp" && !turnStore ? "legacy" : strategy;
  const tirqdpUnavailableNote = strategy === "tirqdp" && !turnStore
    ? "\nnote: retrieval_strategy \"tirqdp\" requested but turn store is unavailable — fell back to legacy BM25+chunk path."
    : null;

  if (args.retrieval_strategy === "deep") {
    // ── Deep session-level path (read-path parity Phase 1, spec 2026-06-05) ──
    // Session-level DCG scoring + cross-encoder reranker (query-heuristic gated
    // for temporal/counting) + event signals via engine.searchSessionLevel, then
    // dense-turn fusion — mirrors the benchmark sessionScoring path
    // (retrieve.ts:218-278) that reproduced 84.4%. Opt-in; SQLite backend.
    const limit = Math.min(searchOptions.limit ?? 20, 100);

    // Candidate pool: must match the benchmark exactly.
    // retrieve.ts:221-224: searchSessionLevel(query, { limit: 60, sessionK: 20 })
    // The pool (limit=60) is wider than the final output (sessionK=20) to ensure
    // session-level DCG scoring + reranker have a rich candidate set to work with.
    // The previous bug: { ...searchOptions, sessionK: limit } forwarded limit=20 as
    // both the pool AND sessionK, starving the scoring step of candidates.
    const DEEP_CANDIDATE_POOL = 60; // mirrors retrieve.ts:223 — do NOT lower
    const DEEP_SESSION_K = 20;      // mirrors retrieve.ts:223 — do NOT lower

    // Session lane: session-scoring + reranker + events
    let sessionLane = await engine.searchSessionLevel(args.query, {
      ...searchOptions,
      limit: DEEP_CANDIDATE_POOL,
      sessionK: DEEP_SESSION_K,
    });

    // Merge knowledge entries (identical to every other branch)
    if (knowledgeStore) {
      const knowledgeResults = await searchKnowledgeViaStore(knowledgeStore, args.query, searchOptions);
      if (knowledgeResults.length > 0) {
        sessionLane = [...sessionLane, ...knowledgeResults]
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
      }
    } else if (db) {
      const knowledgeResults = searchKnowledge(db, args.query, searchOptions);
      if (knowledgeResults.length > 0) {
        sessionLane = [...sessionLane, ...knowledgeResults]
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
      }
    }

    // Dense turn-lane fusion (carries the shipped SSA win; matches retrieve.ts:276-278)
    if (turnStore) {
      engine.setKnowledgeTurnStore(turnStore);
      const turnHits = await engine.searchTurns(args.query, {
        userId: searchOptions.user ?? undefined,
        project: searchOptions.project,
        limit,
      });
      // FIX (session-count collapse, 2026-06-07): do NOT slice(0, limit) the raw fused
      // list before deduplication. fuseDenseTurnLane returns individual TURN entries
      // interleaved with SESSION entries; slicing to limit=20 before dedup means ~10
      // turn entries occupy half the budget → deduplicateToSessions inside buildAgentContext
      // collapses them into their parent sessions → only ~7-10 distinct sessions survive
      // instead of the expected ~20 (matching the benchmark's retrieveQuestion path).
      //
      // Fix: deduplicate sessions FIRST (collapsing turns into parent sessions), THEN
      // slice to limit. This ensures ~DEEP_SESSION_K (≈20) distinct sessions reach the
      // answer model, mirroring how retrieve.ts preserves session coverage.
      const fused = fuseDenseTurnLane(sessionLane, turnHits, CONFIG.search.denseTurnLane.maxTurnResults);
      results = deduplicateToSessions(fused).slice(0, limit);
    } else {
      results = deduplicateToSessions(sessionLane).slice(0, limit);
    }

  } else if (CONFIG.search.denseTurnLane.enabled && turnStore && args.retrieval_strategy !== "legacy") {
    // ── Dense turn-lane path (spec 2026-06-03-dense-turn-lane-production-design §3.6) ──
    // Activated when: CONFIG.search.denseTurnLane.enabled (default ON when provider present)
    // AND a turn store is available AND the caller has not explicitly requested "legacy".
    // We check args.retrieval_strategy (raw caller input) NOT the resolved `strategy` variable.
    // `strategy` can equal "legacy" when auto-resolves to legacy via useTirQdp=false, which
    // must NOT suppress the dense lane — only an explicit retrieval_strategy:"legacy" should.
    // The "legacy" param is documented to "force BM25+chunk regardless of config flag" —
    // honouring that promise requires skipping the dense branch entirely.
    //
    // Bypasses the QDP coverage floor for turn hits — vector-only hits (zero lexical overlap
    // with the query) survive fusion. This is the core correctness guard: applying the
    // QDP floor would silently delete exactly the dense-lane wins.

    // Chunk lane: existing search path (semantic bridge or FTS5)
    const chunkLane = asyncSearch
      ? await asyncSearch(query, searchOptions)
      : await engine.search(query, searchOptions);

    // Also merge knowledge entries into chunk lane (same as legacy and tirqdp paths)
    let mergedChunkLane = chunkLane;
    if (knowledgeStore) {
      const knowledgeResults = await searchKnowledgeViaStore(knowledgeStore, args.query, searchOptions);
      if (knowledgeResults.length > 0) {
        mergedChunkLane = [...mergedChunkLane, ...knowledgeResults]
          .sort((a, b) => b.score - a.score)
          .slice(0, Math.min(searchOptions.limit ?? 20, 100));
      }
    } else if (db) {
      const knowledgeResults = searchKnowledge(db, args.query, searchOptions);
      if (knowledgeResults.length > 0) {
        mergedChunkLane = [...mergedChunkLane, ...knowledgeResults]
          .sort((a, b) => b.score - a.score)
          .slice(0, Math.min(searchOptions.limit ?? 20, 100));
      }
    }

    // Turn lane: FTS5+vector hybrid via engine.searchTurns (dense guard fires when
    // engine has embedder+vectorSearch set by initEmbedder).
    engine.setKnowledgeTurnStore(turnStore);
    const limit = Math.min(searchOptions.limit ?? 20, 100);
    const turnHits = await engine.searchTurns(args.query, {
      userId: searchOptions.user ?? undefined,
      project: searchOptions.project,
      limit,
    });

    // Result-granularity RRF fusion — turns enter as source:"turn" SearchResults.
    // NO QDP coverage floor applied (validated mechanism; the floor would eat the win).
    results = fuseDenseTurnLane(mergedChunkLane, turnHits, CONFIG.search.denseTurnLane.maxTurnResults)
      .slice(0, limit);

  } else if (effectiveTirqdp === "tirqdp" && turnStore) {
    // ── TIR+QDP path (TIRQDP-2.1) ────────────────────────────────────────────
    // When the effective strategy is tirqdp and a turn store is available, fuse
    // the chunk lane (existing search results) and the turn lane
    // (knowledge_turns FTS hits) via RRF, then apply QDP pruning.
    // Activated by: CONFIG.search.useTirQdp=true (auto), or retrieval_strategy="tirqdp".
    // NOTE: This branch only runs when the dense-turn-lane is OFF (kill-switch).

    // Chunk lane: existing search path (semantic bridge or FTS5)
    const chunkSearchResults = asyncSearch
      ? await asyncSearch(query, searchOptions)
      : await engine.search(query, searchOptions);

    // Also merge knowledge entries into chunk lane (same as legacy path)
    let chunkLane = chunkSearchResults;
    if (knowledgeStore) {
      const knowledgeResults = await searchKnowledgeViaStore(knowledgeStore, args.query, searchOptions);
      if (knowledgeResults.length > 0) {
        chunkLane = [...chunkLane, ...knowledgeResults]
          .sort((a, b) => b.score - a.score)
          .slice(0, Math.min(searchOptions.limit ?? 20, 100));
      }
    } else if (db) {
      const knowledgeResults = searchKnowledge(db, args.query, searchOptions);
      if (knowledgeResults.length > 0) {
        chunkLane = [...chunkLane, ...knowledgeResults]
          .sort((a, b) => b.score - a.score)
          .slice(0, Math.min(searchOptions.limit ?? 20, 100));
      }
    }

    // Turn lane: knowledge_turns FTS hits via engine.searchTurns. The engine
    // owns the classifier-gated `applyTurnRecencyBoost` invocation per spec
    // 2026-05-25-unified-turn-lane-surface §3.2 — the inline boost block
    // that used to live here was removed.
    // Wire the turn store into the engine so searchTurns can use it.
    // setKnowledgeTurnStore is idempotent when called with the same store.
    engine.setKnowledgeTurnStore(turnStore);
    const limit = Math.min(searchOptions.limit ?? 20, 100);
    const turnHits = await engine.searchTurns(args.query, {
      userId: searchOptions.user ?? undefined,
      project: searchOptions.project,
      limit,
    });

    // Adapt chunkLane → CommunityChunkResult[] for fuseCommunityLanes
    const chunkInputs: CommunityChunkResult[] = chunkLane.map((r, idx) => ({
      id: r.sessionId + ":" + idx,
      score: r.score,
      userId: searchOptions.user ?? null,
      project: r.project ?? null,
      content: r.text,
      tags: r.toolNames,
      createdAt: r.timestamp ?? Date.now(),
    }));

    // Fuse lanes and prune
    const fused = fuseCommunityLanes(chunkInputs, turnHits, {});
    const pruned = recallQdpCommunity(fused, args.query);

    // Convert FusedResult[] → SearchResult[] for the shared rendering path
    results = pruned.map(f => ({
      sessionId: f.id,
      project: f.project ?? "",
      text: f.content,
      score: f.rrfScore,
      confidence: Math.min(f.rrfScore, 1),
      timestamp: f.createdAt,
      toolNames: f.tags,
      role: "mixed" as const,
      source: f.source,   // "turn" | "chunk" — carried through for downstream consumers
    })).slice(0, limit);

  } else {
    // ── Legacy path ──────────────────────────────────────────────────────────
    // Active when: effectiveTirqdp="legacy" (config flag off, or strategy="legacy",
    // or strategy="tirqdp" but turnStore unavailable).
    results = asyncSearch
      ? await asyncSearch(query, searchOptions)
      : await engine.search(query, searchOptions);

    // Also search the knowledge table for stored memories.
    // Prefer IKnowledgeStore (FTS5 with stop-word removal) when available;
    // fall back to raw SQL LIKE (slower, no stop-word handling) when only db is available.
    if (knowledgeStore) {
      const knowledgeResults = await searchKnowledgeViaStore(knowledgeStore, args.query, searchOptions);
      if (knowledgeResults.length > 0) {
        results = [...results, ...knowledgeResults]
          .sort((a, b) => b.score - a.score)
          .slice(0, Math.min(searchOptions.limit ?? 20, 100));
      }
    } else if (db) {
      const knowledgeResults = searchKnowledge(db, args.query, searchOptions);
      if (knowledgeResults.length > 0) {
        results = [...results, ...knowledgeResults]
          .sort((a, b) => b.score - a.score)
          .slice(0, Math.min(searchOptions.limit ?? 20, 100));
      }
    }
  }

  // Record evidence gap if results are empty or low-confidence
  if (db && CONFIG.gaps.enabled) {
    const lowConf = results.length > 0 && results[0].score < CONFIG.search.lowConfidenceThreshold;
    if (results.length === 0 || lowConf) {
      try {
        recordGap(db, {
          query: args.query,
          tool: "search_history",
          project: args.project,
          user: args.user ?? "default",
          resultCount: results.length,
          topScore: results.length > 0 ? results[0].score : null,
          topConfidence: results.length > 0 ? results[0].confidence : null,
        });
      } catch { /* gap recording is best-effort */ }
    }
  }

  if (results.length === 0) {
    // Agent format: clean sentinel for empty results (no chrome).
    if ((args.format as ResponseFormat) === ResponseFormat.AGENT) {
      return `No relevant memory found for "${args.query}".`;
    }
    // Check for gap-aware nudge on empty results
    if (db) {
      try {
        const occurrences = getGapOccurrences(db, args.query, args.project ?? "", args.user ?? "default");
        if (occurrences >= 2) {
          return `No results found for "${args.query}".\nNote: This topic has been searched ${occurrences} times without good matches \u2014 consider using store_memory to record relevant knowledge.`
            + (tirqdpUnavailableNote ?? "");
        }
      } catch { /* best-effort */ }
    }
    return `No results found for "${args.query}".` + (tirqdpUnavailableNote ?? "");
  }

  const format = (args.format as ResponseFormat) || ResponseFormat.STANDARD;

  // Agent format: chronological, dated, clean notes block — the recommended
  // pipeline output for LLM agents (spec 2026-06-07-recommended-agent-pipeline).
  // Evaluated BEFORE toRecords() so the expensive serialization is skipped
  // entirely for agent-format callers.
  if (format === ResponseFormat.AGENT) {
    return buildAgentContext(results, args.query, maxChars);
  }

  const records = toRecords(results, maxChars);

  // TOON format for concise responses
  if (format === ResponseFormat.CONCISE) {
    const serializer = new CompactSerializer("results");
    return `Found ${results.length} result(s) for "${args.query}":\n\n` +
      serializer.serialize(records, { format }) + (tirqdpUnavailableNote ?? "");
  }

  // Detailed: full JSON (for programmatic consumers like strata-py SDK)
  if (format === ResponseFormat.DETAILED) {
    const serializer = new CompactSerializer("results");
    return serializer.serialize(records, { format }) + (tirqdpUnavailableNote ?? "");
  }

  // Standard: structured text (default)
  const lowConf = isLowConfidence(results);
  const header = lowConf
    ? `Found ${results.length} result(s) for "${args.query}" (results may not be relevant — consider rephrasing your query):\n`
    : `Found ${results.length} result(s) for "${args.query}":\n`;
  const lines: string[] = [header];

  // Gap-aware nudge for low-confidence results
  if (lowConf && db) {
    try {
      const occurrences = getGapOccurrences(db, args.query, args.project ?? "", args.user ?? "default");
      if (occurrences >= 2) {
        lines.push(`Note: This topic has been searched ${occurrences} times without good matches \u2014 consider using store_memory to record relevant knowledge.\n`);
      }
    } catch { /* best-effort */ }
  }

  for (const r of results) {
    const projectName = extractProjectName(r.project);
    const date = r.timestamp
      ? new Date(r.timestamp).toLocaleDateString()
      : "unknown date";
    const toolInfo =
      r.toolNames.length > 0 ? ` [tools: ${r.toolNames.join(", ")}]` : "";
    const band = confidenceBand(r.confidence);
    const handle = r.provenance ? ` ${formatProvenanceHandle(r.provenance)}` : "";

    lines.push(`--- ${projectName} (${date}) [${band}]${toolInfo}${handle} ---`);
    const text = r.text.length > maxChars ? r.text.slice(0, maxChars) + "..." : r.text;
    lines.push(text);
    lines.push("");
  }

  return lines.join("\n") + (tirqdpUnavailableNote ?? "");
}
