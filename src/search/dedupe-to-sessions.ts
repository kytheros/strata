import type { SearchResult } from "./sqlite-search-engine.js";

/**
 * Deduplicate SearchResult[] by sessionId → one entry per session.
 *
 * When the search pipeline returns chunk-level results, the same session can
 * appear as multiple SearchResult entries. Groups by sessionId, concatenates
 * texts with "\n\n", keeps the best score and earliest timestamp, merges tool
 * names. Returns results sorted by score descending.
 */
export function deduplicateToSessions(results: SearchResult[]): SearchResult[] {
  const sessions = new Map<string, SearchResult & { texts: string[] }>();

  for (const r of results) {
    const existing = sessions.get(r.sessionId);
    if (!existing) {
      sessions.set(r.sessionId, { ...r, toolNames: r.toolNames ?? [], texts: [r.text] });
    } else {
      existing.texts.push(r.text);
      if (r.score > existing.score) existing.score = r.score;
      if (r.timestamp < existing.timestamp) existing.timestamp = r.timestamp;
      for (const t of (r.toolNames ?? [])) {
        if (!existing.toolNames.includes(t)) existing.toolNames.push(t);
      }
    }
  }

  const deduped: SearchResult[] = [];
  for (const entry of sessions.values()) {
    const { texts, ...rest } = entry;
    deduped.push({ ...rest, text: texts.join("\n\n") });
  }
  deduped.sort((a, b) => b.score - a.score);
  return deduped;
}
