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
  throw new Error("not implemented");
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
  throw new Error("not implemented");
}
