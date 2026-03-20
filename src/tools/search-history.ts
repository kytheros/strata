import type Database from "better-sqlite3";
import type { SqliteSearchEngine, SearchResult, SearchOptions } from "../search/sqlite-search-engine.js";
import { extractProjectName } from "../utils/path-encoder.js";
import { ResponseFormat } from "../utils/response-format.js";
import { CompactSerializer } from "../utils/compact-serializer.js";
import { truncatePreview } from "../utils/response.js";
import { CONFIG } from "../config.js";
import { recordGap, getGapOccurrences } from "../search/evidence-gaps.js";

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

  let results = asyncSearch
    ? await asyncSearch(args.query, searchOptions)
    : await engine.search(args.query, searchOptions);

  // Also search the knowledge table for stored memories
  if (db) {
    const knowledgeResults = searchKnowledge(db, args.query, searchOptions);
    if (knowledgeResults.length > 0) {
      results = [...results, ...knowledgeResults]
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.min(searchOptions.limit ?? 20, 100));
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
