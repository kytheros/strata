import type { SqliteSearchEngine, SearchResult } from "../search/sqlite-search-engine.js";
import { extractProjectName } from "../utils/path-encoder.js";
import { ResponseFormat } from "../utils/response-format.js";
import { CompactSerializer } from "../utils/compact-serializer.js";
import { truncatePreview } from "../utils/response.js";
import { CONFIG } from "../config.js";

function confidenceBand(c: number): string {
  if (c >= CONFIG.search.confidenceHighThreshold) return "high";
  if (c >= CONFIG.search.confidenceMediumThreshold) return "medium";
  return "low";
}

function isLowConfidence(results: SearchResult[]): boolean {
  return results.length > 0 && results[0].score < CONFIG.search.lowConfidenceThreshold;
}

export interface FindSolutionsArgs {
  error_or_problem: string;
  technology?: string;
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
    tools: r.toolNames.length > 0 ? r.toolNames.join(", ") : "",
    snippet: truncatePreview(r.text, 200),
    text: r.text.length > 600 ? r.text.slice(0, 600) + "..." : r.text,
  }));
}

export function handleFindSolutions(
  engine: SqliteSearchEngine,
  args: FindSolutionsArgs
): string {
  const results = engine.searchSolutions(
    args.error_or_problem,
    args.technology,
    args.user
  );

  if (results.length === 0) {
    return `No past solutions found for "${args.error_or_problem}".`;
  }

  const records = toRecords(results.slice(0, 10));
  const format = (args.format as ResponseFormat) || ResponseFormat.STANDARD;

  // TOON format for concise responses
  if (format === ResponseFormat.CONCISE) {
    const serializer = new CompactSerializer("results");
    return `Found ${results.length} potential solution(s) for "${args.error_or_problem}":\n\n` +
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
    ? `Found ${results.length} potential solution(s) for "${args.error_or_problem}" (results may not be relevant — consider rephrasing your query):\n`
    : `Found ${results.length} potential solution(s) for "${args.error_or_problem}":\n`;
  const lines: string[] = [header];

  for (const r of results.slice(0, 10)) {
    const projectName = extractProjectName(r.project);
    const date = r.timestamp
      ? new Date(r.timestamp).toLocaleDateString()
      : "unknown date";
    const band = confidenceBand(r.confidence);

    lines.push(`--- ${projectName} (${date}) [${band}] ---`);
    const text = r.text.length > 600 ? r.text.slice(0, 600) + "..." : r.text;
    lines.push(text);
    lines.push("");
  }

  return lines.join("\n");
}
