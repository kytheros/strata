/**
 * KU-gated turn-lane fusion (spec 2026-05-26-b2-ku-fusion-design).
 *
 * Operates on SearchResult[] (chunk-level chunks). Two modes:
 *
 *   appendUniqueByLane — M1: add chunks from turn-lane sessions not
 *     already covered by chunk-lane top-20, up to maxAppend extras.
 *
 *   rrfFuse — M2: RRF-fuse chunk-lane and turn-lane session ranks,
 *     re-sort the combined chunk pool.
 *
 * Both functions are PURE — they only read the inputs and return a new
 * array. The caller is responsible for invoking the wider-net retrieval
 * helper and providing its results as `widerNetChunks`.
 */

import type { SearchResult } from "../../src/search/sqlite-search-engine.js";
import type { KnowledgeTurnHit } from "../../src/storage/interfaces/knowledge-turn-store.js";
import { strataSessionIdToIndex } from "./ingest.js";
import type { IngestedQuestion } from "./ingest.js";

/** Map a strata-internal session ID to its LongMemEval-domain session ID. */
function toLmeSessionId(strataId: string, ingested: IngestedQuestion): string | null {
  const idx = strataSessionIdToIndex(strataId);
  if (idx < 0 || idx >= ingested.indexToSessionId.length) return null;
  return ingested.indexToSessionId[idx];
}

/** Distinct LongMemEval session IDs surfaced by the turn-lane top-K. */
function turnLaneSessions(turnHits: KnowledgeTurnHit[], ingested: IngestedQuestion): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of turnHits) {
    const lme = toLmeSessionId(h.row.sessionId, ingested);
    if (lme && !seen.has(lme)) {
      seen.add(lme);
      out.push(lme);
    }
  }
  return out;
}

/** Distinct LongMemEval session IDs surfaced by the chunk-lane top-N. */
function chunkLaneSessions(chunkResults: SearchResult[], ingested: IngestedQuestion): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of chunkResults) {
    const lme = toLmeSessionId(r.sessionId, ingested);
    if (lme && !seen.has(lme)) {
      seen.add(lme);
      out.push(lme);
    }
  }
  return out;
}

/**
 * M1 — Append unique. Chunk-lane top-20 sessions stay primary; chunks
 * from turn-lane sessions NOT in the chunk-lane top-20 are appended
 * (up to maxAppend extras). Chunks are taken from `widerNetChunks`
 * (typically searchAsync(limit=100)) filtered by session.
 */
export function appendUniqueByLane(
  chunkTop20: SearchResult[],
  turnHits: KnowledgeTurnHit[],
  widerNetChunks: SearchResult[],
  ingested: IngestedQuestion,
  maxAppend: number,
): SearchResult[] {
  const chunkSessions = new Set(chunkLaneSessions(chunkTop20, ingested));
  const turnSessions = turnLaneSessions(turnHits, ingested);

  // Build a quick lookup: LME session ID → list of chunks from widerNet
  const chunksByLmeSession = new Map<string, SearchResult[]>();
  for (const c of widerNetChunks) {
    const lme = toLmeSessionId(c.sessionId, ingested);
    if (!lme) continue;
    const arr = chunksByLmeSession.get(lme) ?? [];
    arr.push(c);
    chunksByLmeSession.set(lme, arr);
  }

  const appended: SearchResult[] = [];
  const extrasUsed = new Set<string>();
  for (const lme of turnSessions) {
    if (chunkSessions.has(lme) || extrasUsed.has(lme)) continue;
    if (appended.length >= maxAppend) break;
    extrasUsed.add(lme);

    const chunksForSession = chunksByLmeSession.get(lme);
    if (chunksForSession && chunksForSession.length > 0) {
      // Use the highest-scored chunk from the wider net for this session.
      const best = chunksForSession.reduce((a, b) => (a.score >= b.score ? a : b));
      appended.push(best);
    } else {
      // Fallback: synthesize a SearchResult from the matching turn hit so
      // the session enters the answer context even when chunk-lane has no
      // representation for it.
      const hit = turnHits.find(
        (h) => toLmeSessionId(h.row.sessionId, ingested) === lme,
      );
      if (!hit) continue; // defensive — turnSessions came from turnHits, so this shouldn't happen
      appended.push({
        sessionId: hit.row.sessionId,
        project: hit.row.project ?? "",
        text: hit.row.content,
        score: hit.score,
        confidence: Math.min(hit.score, 1),
        timestamp: hit.row.createdAt,
      } as SearchResult);
    }
  }

  return [...chunkTop20, ...appended];
}

/**
 * M2 — RRF-fuse chunk-lane and turn-lane session ranks. Compute
 *   score(s) = 1/(rrfK + chunkRank(s)) + 1/(rrfK + turnRank(s))
 * for each session in (chunkTop20 sessions ∪ turn-lane sessions).
 * Re-sort the wider-net chunks by their session's RRF score (chunks of
 * the same session retain their original chunk-lane rank as a tiebreaker).
 * Return top (20 + maxAppend) chunks.
 */
export function rrfFuse(
  chunkTop20: SearchResult[],
  turnHits: KnowledgeTurnHit[],
  widerNetChunks: SearchResult[],
  ingested: IngestedQuestion,
  maxAppend: number,
  rrfK: number,
): SearchResult[] {
  // Build session-level ranks for both lanes
  const chunkSessionsOrdered = chunkLaneSessions(chunkTop20, ingested);
  const turnSessionsOrdered = turnLaneSessions(turnHits, ingested);

  const chunkRankByLme = new Map<string, number>();
  chunkSessionsOrdered.forEach((s, i) => chunkRankByLme.set(s, i + 1));
  const turnRankByLme = new Map<string, number>();
  turnSessionsOrdered.forEach((s, i) => turnRankByLme.set(s, i + 1));

  // Union of LongMemEval session IDs from both lanes
  const allLmeSessions = new Set<string>([
    ...chunkSessionsOrdered,
    ...turnSessionsOrdered,
  ]);

  // RRF score per session
  const rrfByLme = new Map<string, number>();
  for (const lme of allLmeSessions) {
    const cr = chunkRankByLme.get(lme);
    const tr = turnRankByLme.get(lme);
    let s = 0;
    if (cr !== undefined) s += 1 / (rrfK + cr);
    if (tr !== undefined) s += 1 / (rrfK + tr);
    rrfByLme.set(lme, s);
  }

  // Order sessions by RRF score desc, tiebreak by chunk-lane rank asc
  // (sessions only in turn-lane get effectively-infinite chunk rank → fall to back of ties).
  const orderedLme = [...allLmeSessions].sort((a, b) => {
    const sa = rrfByLme.get(a)!;
    const sb = rrfByLme.get(b)!;
    if (sa !== sb) return sb - sa;
    const ca = chunkRankByLme.get(a) ?? Number.POSITIVE_INFINITY;
    const cb = chunkRankByLme.get(b) ?? Number.POSITIVE_INFINITY;
    return ca - cb;
  });

  // Pick the best chunk per session from the wider net (or synth from turn hit)
  const chunksByLmeSession = new Map<string, SearchResult[]>();
  for (const c of widerNetChunks) {
    const lme = toLmeSessionId(c.sessionId, ingested);
    if (!lme) continue;
    const arr = chunksByLmeSession.get(lme) ?? [];
    arr.push(c);
    chunksByLmeSession.set(lme, arr);
  }

  const out: SearchResult[] = [];
  const cap = 20 + maxAppend;
  for (const lme of orderedLme) {
    if (out.length >= cap) break;
    const chunks = chunksByLmeSession.get(lme);
    if (chunks && chunks.length > 0) {
      const best = chunks.reduce((a, b) => (a.score >= b.score ? a : b));
      out.push(best);
    } else {
      const hit = turnHits.find(
        (h) => toLmeSessionId(h.row.sessionId, ingested) === lme,
      );
      if (!hit) continue;
      out.push({
        sessionId: hit.row.sessionId,
        project: hit.row.project ?? "",
        text: hit.row.content,
        score: hit.score,
        confidence: Math.min(hit.score, 1),
        timestamp: hit.row.createdAt,
      } as SearchResult);
    }
  }

  return out;
}
