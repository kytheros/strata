/**
 * query-runner.ts — Phase 7.2 T9
 *
 * Calls the real production knowledge store search to retrieve facts
 * inserted by the pipeline driver. Pins to the legacy BM25 retrieval
 * lane (retrieval_strategy: "legacy") to produce low-variance baseline
 * measurements that are not contaminated by classifier routing decisions.
 *
 * Implementation notes:
 *
 * 1. The plan proposed calling the MCP server.tools.get("search_history").call(...)
 *    pattern. The MCP SDK's _registeredTools are internal; and search_history
 *    returns a formatted string, not structured JSON. We instead call
 *    storage.knowledge.search() directly, which is the real production FTS5
 *    search path that search_history also traverses.
 *
 * 2. turn_index is NOT surfaced by the knowledge store search — entries
 *    are stored per-session, not per-turn. The RetrievedTurn.turn_index
 *    field is therefore omitted from this implementation.
 *    FLAG: Recall@K in T10 must match on session_id only (not turn_index).
 *    This is a known limitation — per-turn indexing requires the TIR+QDP
 *    turn store (knowledge_turns table), which is populated by the
 *    IncrementalIndexer from actual session files, not from drivePipeline's
 *    knowledge.addEntry() path.
 *
 * 3. retrieval_strategy: "legacy" is respected by default. The knowledge
 *    store FTS5 search IS the legacy BM25+chunk lane for knowledge entries
 *    (same path as handleSearchHistory's searchKnowledgeViaStore()).
 */

import type { IsolatedHandle } from "./isolated-db.js";

export interface RetrievedTurn {
  /**
   * The session_id from the fixture (set as KnowledgeEntry.sessionId).
   * turn_index is not surfaced — knowledge entries are stored per-session.
   */
  session_id: string;
  /** Content of the retrieved fact. */
  content: string;
  /**
   * Normalized rank score (1.0 = top result, decreasing by rank).
   * FTS5 BM25 ranking order is preserved; score is rank-normalized.
   */
  score: number;
}

export interface QueryResult {
  retrievedTurns: RetrievedTurn[];
}

/**
 * Queries the isolated server's knowledge store for facts relevant to the query.
 *
 * Uses the same FTS5 search path as search_history's legacy lane
 * (storage.knowledge.search), pinned to legacy strategy for deterministic
 * baseline measurements.
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
  // Use the real production FTS5 knowledge store search.
  // This is the same path that handleSearchHistory's searchKnowledgeViaStore() calls.
  // retrieval_strategy: "legacy" is respected by default — knowledge.search() is BM25 only.
  const entries = await handle.server.storage.knowledge.search(query);

  const sliced = entries.slice(0, k);
  const total = sliced.length;

  const retrievedTurns: RetrievedTurn[] = sliced.map((entry, idx) => ({
    session_id: entry.sessionId,
    content: entry.summary,
    // Normalize: top result gets 1.0, last gets 1/total (never 0).
    score: total > 1 ? 1 - (idx / total) : 1.0,
  }));

  return { retrievedTurns };
}
