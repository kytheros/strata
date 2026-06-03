/**
 * Dense turn-lane fusion (spec 2026-06-02-dense-turn-lane-design §3.5,
 * spec 2026-06-03-dense-turn-lane-production-design §3.1).
 *
 * RRF-fuses the chunk-lane SearchResult[] with the (already-hybrid) turn hits
 * at RESULT granularity: each turn enters the answer context as its own
 * SearchResult (source="turn"), NOT collapsed into a session-best chunk (that
 * session-collapse is what produced the KU-fusion null). Pure function.
 *
 * Ported verbatim from benchmarks/longmemeval/dense-turn-fusion.ts; the
 * benchmark now imports from here to maintain a single source of truth.
 */
import type { SearchResult } from "./sqlite-search-engine.js";
import type { KnowledgeTurnHit } from "../storage/interfaces/knowledge-turn-store.js";
import { reciprocalRankFusion } from "./result-ranker.js";

export function fuseDenseTurnLane(
  chunkResults: SearchResult[],
  turnHits: KnowledgeTurnHit[],
  maxTurnResults: number,
): SearchResult[] {
  if (turnHits.length === 0) return chunkResults;

  const turnResults: SearchResult[] = turnHits.slice(0, maxTurnResults).map((h) => ({
    sessionId: h.row.sessionId,
    project: h.row.project ?? "",
    text: h.row.content,
    score: h.score,
    confidence: Math.min(h.score, 1),
    timestamp: h.row.createdAt,
    toolNames: [],
    role: (h.row.speaker === "user" || h.row.speaker === "assistant" ? h.row.speaker : "mixed") as
      "user" | "assistant" | "mixed",
    source: "turn" as const,
  }));

  // Two ranked lists keyed on synthetic ids (rank = array position).
  const chunkList = chunkResults.map((r, i) => ({ docId: `c${i}`, score: r.score }));
  const turnList = turnResults.map((r, i) => ({ docId: `t${i}`, score: r.score }));
  const fused = reciprocalRankFusion([chunkList, turnList]);

  const byId = new Map<string, SearchResult>();
  chunkResults.forEach((r, i) => byId.set(`c${i}`, r));
  turnResults.forEach((r, i) => byId.set(`t${i}`, r));

  const cap = chunkResults.length + turnResults.length;
  const out: SearchResult[] = [];
  for (const [docId] of [...fused.entries()].sort((a, b) => b[1] - a[1])) {
    const r = byId.get(docId);
    if (r) out.push(r);
    if (out.length >= cap) break;
  }
  return out;
}
