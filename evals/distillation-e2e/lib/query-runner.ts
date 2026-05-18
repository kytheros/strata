/**
 * query-runner.ts — Phase 7.2 T9 + T9.5
 *
 * Retrieves raw turns from knowledge_turns (FTS5 BM25, scoped to the
 * isolated db opened by withIsolatedStrata). drivePipeline (T9.5) writes
 * every fixture turn to this store, so retrieval matches against raw text
 * instead of summarized knowledge_entries.
 *
 * Why turns and not knowledge_entries: the harness measures whether the
 * eval can find specific entities/values in the corpus. Extracted summaries
 * paraphrase those specifics away ("player is organizing coupons" loses
 * "redeemed $5 at Target"), making answer scoring impossible. The turn lane
 * preserves the original phrasing the query is asking about.
 */

import type { IsolatedHandle } from "./isolated-db.js";

export interface RetrievedTurn {
  /** session_id from the fixture (set on knowledge_turns row). */
  session_id: string;
  /** Ordinal position of the turn within the session (0-indexed). */
  turn_index: number;
  /** Raw turn content. */
  content: string;
  /**
   * Normalized rank score (1.0 = top, decreasing by rank). The underlying
   * FTS5 BM25 is negated-bm25; we rank-normalize for stable downstream use.
   */
  score: number;
}

export interface QueryResult {
  retrievedTurns: RetrievedTurn[];
}

/**
 * Queries knowledge_turns FTS5 for raw turns matching the query.
 *
 * @param handle   Isolated server handle from withIsolatedStrata
 * @param query    The fixture query string
 * @param k        Top-K results to return (default 10)
 */
export async function runQuery(
  handle: IsolatedHandle,
  query: string,
  k: number = 10
): Promise<QueryResult> {
  const hits = await handle.knowledgeTurn.searchByQuery(query, { limit: k });

  const total = hits.length;
  const retrievedTurns: RetrievedTurn[] = hits.map((hit, idx) => ({
    session_id: hit.row.sessionId,
    turn_index: hit.row.messageIndex,
    content: hit.row.content,
    score: total > 1 ? 1 - idx / total : 1.0,
  }));

  return { retrievedTurns };
}
