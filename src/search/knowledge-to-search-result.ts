/**
 * Shared utility: convert a KnowledgeEntry to the SearchResult shape used by
 * SqliteSearchEngine and the CLI formatter.
 *
 * Extracted from src/tools/search-history.ts so both the MCP tool path
 * (handleSearchHistory) and the CLI path (runSearch) can share the same
 * mapping logic without duplication.
 */

import type { KnowledgeEntry } from "../knowledge/knowledge-store.js";
import type { SearchResult } from "./sqlite-search-engine.js";

/**
 * Map a single KnowledgeEntry to a SearchResult.
 *
 * Score formula: (importance ?? 0.5) * 10
 *   - importance range [0, 1] → score range [0, 10]
 *   - Matches the formula used in search-history.ts (searchKnowledge & searchKnowledgeViaStore)
 *     so merged lists sort consistently.
 *
 * `confidence` is mathematically redundant with `score` here (always `score / 10`
 * given importance ∈ [0, 1]). Kept for parity with the FTS5 SearchResult shape and
 * as forward-compat: if the score formula ever adds bonuses that push past 10,
 * confidence would diverge from a direct `score / 10` and the field becomes load-bearing.
 */
export function knowledgeEntryToSearchResult(entry: KnowledgeEntry): SearchResult {
  const text =
    entry.details && entry.details !== entry.summary
      ? `[${entry.type}] ${entry.summary}\n${entry.details}`
      : `[${entry.type}] ${entry.summary}`;
  const tags = entry.tags ?? [];
  const baseScore = (entry.importance ?? 0.5) * 10;
  return {
    sessionId: entry.sessionId || "knowledge",
    project: entry.project,
    text,
    score: baseScore,
    confidence: Math.min(baseScore / 10, 1),
    timestamp: entry.timestamp,
    toolNames: tags.length > 0 ? [`tags:${tags.join(",")}`] : [],
    role: "assistant" as const,
  };
}

/**
 * Map an array of KnowledgeEntry objects to SearchResult objects.
 * Convenience wrapper for bulk conversion.
 */
export function knowledgeEntriesToSearchResults(
  entries: KnowledgeEntry[]
): SearchResult[] {
  return entries.map(knowledgeEntryToSearchResult);
}
