/**
 * query-runner.ts — Phase 7.2 T9 + T9.5 + v2 Phase 7.1
 *
 * Thin wrapper around retrieve-strategies dispatch. Default strategy is
 * "turns" — preserves the T17 baseline behavior (66.7% answer / 100% recall
 * on the 36-fixture set as of 2026-05-17).
 *
 * Per-fixture strategy selection happens in run-eval.ts via
 * failureModeToStrategy(). This file only knows how to dispatch.
 */

import type { IsolatedHandle } from "./isolated-db.js";
import { retrieveTurns, type RetrievalStrategy, type RetrievedTurn } from "./retrieval-strategies.js";

export type { RetrievedTurn, RetrievalStrategy };

export interface QueryResult {
  retrievedTurns: RetrievedTurn[];
}

export async function runQuery(
  handle: IsolatedHandle,
  query: string,
  k: number = 10,
  strategy: RetrievalStrategy = "turns",
): Promise<QueryResult> {
  const retrievedTurns = await retrieveTurns(handle, query, k, strategy);
  return { retrievedTurns };
}
