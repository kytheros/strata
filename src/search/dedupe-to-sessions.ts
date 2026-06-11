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
      if (!Number.isFinite(existing.timestamp) || (Number.isFinite(r.timestamp) && r.timestamp < existing.timestamp)) existing.timestamp = r.timestamp;
      for (const t of (r.toolNames ?? [])) {
        if (!existing.toolNames.includes(t)) existing.toolNames.push(t);
      }
      // A merged note containing conversation evidence is session-class even if
      // a knowledge entry contributed text (#33 source-aware slice depends on this).
      if (existing.source === "document" && r.source !== "document" && r.source !== undefined) {
        existing.source = r.source;
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

/**
 * Source-aware final slice for the deep retrieval path (#33 fix).
 *
 * Session-class evidence (conversation sessions + turn-sourced sessions) fills
 * up to `limit` slots in score order. Knowledge-class entries
 * (source === "document") never displace session evidence: they pass through
 * as supplemental notes, capped at `knowledgeCap`. Input is expected
 * score-descending (deduplicateToSessions output); relative order is preserved.
 */
export function sliceWithKnowledgeSupplement(
  entries: SearchResult[],
  limit: number,
  knowledgeCap: number,
): SearchResult[] {
  const out: SearchResult[] = [];
  let sessions = 0;
  let knowledge = 0;
  for (const r of entries) {
    if (r.source === "document") {
      if (knowledge < knowledgeCap) { out.push(r); knowledge++; }
    } else if (sessions < limit) {
      out.push(r);
      sessions++;
    }
  }
  return out;
}
