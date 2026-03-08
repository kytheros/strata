import type { SqliteSearchEngine, SearchResult } from "../search/sqlite-search-engine.js";
import { extractProjectName } from "../utils/path-encoder.js";
import { ResponseFormat } from "../utils/response-format.js";
import { CompactSerializer } from "../utils/compact-serializer.js";
import { truncatePreview } from "../utils/response.js";
import { CONFIG } from "../config.js";

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
}

/**
 * Normalize search results into serializable records.
 */
function toRecords(results: SearchResult[]): Record<string, unknown>[] {
  return results.map((r) => ({
    project: extractProjectName(r.project),
    sessionId: r.sessionId,
    date: r.timestamp ? new Date(r.timestamp).toLocaleDateString() : "unknown",
    score: Math.round(r.score * 100) / 100,
    confidence: r.confidence,
    role: r.role,
    tools: r.toolNames.length > 0 ? r.toolNames.join(", ") : "",
    snippet: truncatePreview(r.text, 200),
    text: r.text.length > 500 ? r.text.slice(0, 500) + "..." : r.text,
  }));
}

export function handleSearchHistory(
  engine: SqliteSearchEngine,
  args: SearchHistoryArgs
): string {
  const results = engine.search(args.query, {
    limit: args.limit,
    project: args.project,
    includeContext: args.include_context,
    user: args.user,
  });

  if (results.length === 0) {
    return `No results found for "${args.query}".`;
  }

  const records = toRecords(results);
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

  for (const r of results) {
    const projectName = extractProjectName(r.project);
    const date = r.timestamp
      ? new Date(r.timestamp).toLocaleDateString()
      : "unknown date";
    const toolInfo =
      r.toolNames.length > 0 ? ` [tools: ${r.toolNames.join(", ")}]` : "";
    const band = confidenceBand(r.confidence);

    lines.push(`--- ${projectName} (${date}) [${band}]${toolInfo} ---`);
    const text = r.text.length > 500 ? r.text.slice(0, 500) + "..." : r.text;
    lines.push(text);
    lines.push("");
  }

  return lines.join("\n");
}
