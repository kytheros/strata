/**
 * retrieval-strategies.ts — Phase 7.1 (v2 harness)
 *
 * Strategy dispatcher for the distillation harness. Each strategy returns
 * RetrievedTurn[] in rank order. All strategies share the same shape so the
 * downstream answer-generator + recall-scorer don't need strategy-aware code.
 *
 * Strategy → underlying primitive(s):
 *   turns    → handle.knowledgeTurn.searchByQuery
 *   entries  → handle.server.storage.knowledge.search
 *   rrf-both → fuseCommunityLanes(entries-as-chunks, turn-hits)
 *   tirqdp   → fuseCommunityLanes + recallQdpCommunity
 *   legacy   → handle.server.storage.knowledge.search only
 *              (in the harness, the FTS-chunk lane is empty because no session
 *              ingestion runs; legacy reduces to the entries lane. The spec
 *              §4.2 still uses "legacy" as the temporal default; we treat
 *              that as "entries lane with no rerank/RRF" for harness purposes.)
 */

import { fuseCommunityLanes, type CommunityChunkResult } from "../../../src/search/recall-fusion-community.js";
import { recallQdpCommunity } from "../../../src/search/recall-qdp-community.js";
import type { IsolatedHandle } from "./isolated-db.js";

export type RetrievalStrategy =
  | "turns"
  | "entries"
  | "rrf-both"
  | "tirqdp"
  | "legacy";

export interface RetrievedTurn {
  session_id: string;
  /**
   * 0-indexed position of the source turn within its session. -1 sentinel
   * when the strategy retrieves from knowledge_entries (which is per-session,
   * not per-turn). Recall-scorer matches on session_id when turn_index is -1.
   */
  turn_index: number;
  content: string;
  score: number;
}

export async function retrieveTurns(
  handle: IsolatedHandle,
  query: string,
  k: number,
  strategy: RetrievalStrategy,
): Promise<RetrievedTurn[]> {
  switch (strategy) {
    case "turns":     return retrieveTurnsLane(handle, query, k);
    case "entries":   return retrieveEntriesLane(handle, query, k);
    case "rrf-both":  return retrieveRrfBoth(handle, query, k, /* withQdp */ false);
    case "tirqdp":    return retrieveRrfBoth(handle, query, k, /* withQdp */ true);
    case "legacy":    return retrieveLegacyLane(handle, query, k);
  }
}

async function retrieveTurnsLane(handle: IsolatedHandle, query: string, k: number): Promise<RetrievedTurn[]> {
  const hits = await handle.knowledgeTurn.searchByQuery(query, { userId: undefined, limit: k });
  const total = hits.length;
  return hits.map((hit, idx) => ({
    session_id: hit.row.sessionId,
    turn_index: hit.row.messageIndex,
    content: hit.row.content,
    score: total > 1 ? 1 - idx / total : 1.0,
  }));
}

async function retrieveEntriesLane(handle: IsolatedHandle, query: string, k: number): Promise<RetrievedTurn[]> {
  const entries = await handle.server.storage.knowledge.search(query);
  const sliced = entries.slice(0, k);
  const total = sliced.length;
  return sliced.map((e, idx) => ({
    session_id: e.sessionId,
    turn_index: -1,
    content: e.summary,
    score: total > 1 ? 1 - idx / total : 1.0,
  }));
}

async function retrieveRrfBoth(
  handle: IsolatedHandle,
  query: string,
  k: number,
  withQdp: boolean,
): Promise<RetrievedTurn[]> {
  // Lane A: knowledge entries adapted as CommunityChunkResult[].
  const entries = await handle.server.storage.knowledge.search(query);
  const chunkLane: CommunityChunkResult[] = entries.slice(0, k).map((e, idx) => ({
    id: `${e.sessionId}:${idx}`,
    score: entries.length > 1 ? 1 - idx / entries.length : 1.0,
    userId: null,
    project: e.project,
    content: e.summary,
    tags: e.tags ?? [],
    createdAt: e.timestamp,
  }));

  // Lane B: knowledge_turns FTS hits.
  const turnHits = await handle.knowledgeTurn.searchByQuery(query, { userId: undefined, limit: k });

  // Fuse + optional QDP.
  const fused = fuseCommunityLanes(chunkLane, turnHits, {});
  const final = withQdp ? recallQdpCommunity(fused, query) : fused;
  const sliced = final.slice(0, k);
  const total = sliced.length;

  // Build a turnId → row lookup so we can recover turn_index for turn-sourced hits.
  const turnIndex = new Map(turnHits.map((h) => [h.row.turnId, h.row]));

  return sliced.map((f, idx) => {
    const turnRow = turnIndex.get(f.id);
    if (turnRow) {
      return {
        session_id: turnRow.sessionId,
        turn_index: turnRow.messageIndex,
        content: f.content,
        score: total > 1 ? 1 - idx / total : 1.0,
      };
    }
    // chunk-sourced: f.id is `${sessionId}:${idx}`; split on the last colon.
    const colon = f.id.lastIndexOf(":");
    const sessionId = colon === -1 ? f.id : f.id.slice(0, colon);
    return {
      session_id: sessionId,
      turn_index: -1,
      content: f.content,
      score: total > 1 ? 1 - idx / total : 1.0,
    };
  });
}

async function retrieveLegacyLane(handle: IsolatedHandle, query: string, k: number): Promise<RetrievedTurn[]> {
  // In the harness, the FTS-chunk lane is empty (no session ingestion). The
  // production legacy path merges engine.search + storage.knowledge.search;
  // here that reduces to storage.knowledge.search alone. This is documented
  // as a known limitation in the v2 spec §9 "Risks".
  return retrieveEntriesLane(handle, query, k);
}
