import type Database from "better-sqlite3";
import type { SqliteSearchEngine, SearchResult, SearchOptions } from "../search/sqlite-search-engine.js";
import { extractProjectName } from "../utils/path-encoder.js";
import { ResponseFormat } from "../utils/response-format.js";
import { CompactSerializer } from "../utils/compact-serializer.js";
import { truncatePreview } from "../utils/response.js";
import { CONFIG } from "../config.js";
import { recordGap, getGapOccurrences } from "../search/evidence-gaps.js";

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
}

/**
 * Normalize search results into serializable records.
 */
function toRecords(results: SearchResult[], maxChars: number): Record<string, unknown>[] {
  return results.map((r) => ({
    project: extractProjectName(r.project),
    sessionId: r.sessionId,
    date: r.timestamp ? new Date(r.timestamp).toLocaleDateString() : "unknown",
    score: Math.round(r.score * 100) / 100,
    confidence: r.confidence,
    role: r.role,
    tools: r.toolNames.length > 0 ? r.toolNames.join(", ") : "",
    snippet: truncatePreview(r.text, 200),
    text: r.text.length > maxChars ? r.text.slice(0, maxChars) + "..." : r.text,
  }));
}

export async function handleSearchHistory(
  engine: SqliteSearchEngine,
  args: SearchHistoryArgs,
  db?: Database.Database,
  asyncSearch?: (query: string, options: SearchOptions) => Promise<SearchResult[]>
): Promise<string> {
  const maxChars = Math.min(Math.max(args.max_chars ?? 2500, 1), 10000);

  const searchOptions: SearchOptions = {
    limit: args.limit,
    project: args.project,
    includeContext: args.include_context,
    user: args.user,
  };

  const results = asyncSearch
    ? await asyncSearch(args.query, searchOptions)
    : engine.search(args.query, searchOptions);

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
    // Check for gap-aware nudge on empty results
    if (db) {
      try {
        const occurrences = getGapOccurrences(db, args.query, args.project ?? "", args.user ?? "default");
        if (occurrences >= 2) {
          return `No results found for "${args.query}".\nNote: This topic has been searched ${occurrences} times without good matches \u2014 consider using store_memory to record relevant knowledge.`;
        }
      } catch { /* best-effort */ }
    }
    return `No results found for "${args.query}".`;
  }

  const records = toRecords(results, maxChars);
  const format = (args.format as ResponseFormat) || ResponseFormat.STANDARD;

  // TOON format for concise responses
  if (format === ResponseFormat.CONCISE) {
    const serializer = new CompactSerializer("results");
    return `Found ${results.length} result(s) for "${args.query}":\n\n` +
      serializer.serialize(records, { format });
  }

  // Detailed: full JSON (for programmatic consumers like strata-py SDK)
  if (format === ResponseFormat.DETAILED) {
    const serializer = new CompactSerializer("results");
    return serializer.serialize(records, { format });
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

    lines.push(`--- ${projectName} (${date}) [${band}]${toolInfo} ---`);
    const text = r.text.length > maxChars ? r.text.slice(0, maxChars) + "..." : r.text;
    lines.push(text);
    lines.push("");
  }

  return lines.join("\n");
}
