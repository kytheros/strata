import type { ExpectedEvidenceTurn } from "./fixture-types.js";
import type { RetrievedTurn } from "./query-runner.js";

export interface RecallInput {
  expected: ExpectedEvidenceTurn[];
  min_recall_at_k: number;
}

/**
 * Session-level Recall@K matching (v1 — turn_index ignored).
 *
 * Counts how many `expected[i]` items have their `session_id` in the
 * retrieved set. Returns 1.0 when count >= min_recall_at_k, else 0.0.
 *
 * The `turn_index` field on expected items is preserved in fixtures for
 * a future Option B follow-up (T9.5 — wire turn-level ingestion) but
 * is NOT consulted today. See plan §Task 10 v1 SCOPE note.
 */
export function scoreRecall(input: RecallInput, retrieved: RetrievedTurn[]): number {
  const retrievedSessions = new Set(retrieved.map((r) => r.session_id));
  let hits = 0;
  for (const ev of input.expected) {
    if (retrievedSessions.has(ev.session_id)) hits += 1;
  }
  return hits >= input.min_recall_at_k ? 1.0 : 0.0;
}
