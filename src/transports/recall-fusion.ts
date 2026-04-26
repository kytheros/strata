/**
 * recall-fusion — Reciprocal Rank Fusion for the NPC recall pipeline.
 *
 * Wraps an RRF merge with a source-tagged candidate type so the QDP layer
 * downstream can prune with source-awareness if needed. Sources today:
 * 'turn' (npc_turns) and 'fact' (npc_memories). Both are passed in as
 * already-ranked input lists.
 *
 * Re-uses the configured `rrfK` constant (40) from config.search — the
 * AutoResearch-optimized value already used by the community-path hybrid
 * search. Keeps a single tuning surface for fusion across the codebase.
 *
 * Spec: 2026-04-26-npc-recall-tir-qdp-design.md §Read path.
 */

import { CONFIG } from "../config.js";

export type RecallSource = "turn" | "fact";

export interface RecallCandidate {
  id: string;                  // turn_id or memory_id
  score: number;               // pre-fusion score (sort within source list before RRF)
  source: RecallSource;
  content: string;             // raw text for downstream QDP + projection
  tags: string[];              // for filler filter
}

export interface FusedCandidate extends RecallCandidate {
  rrfScore: number;
}

/**
 * Fuse two or more pre-ranked candidate lists via RRF.
 * Each list is assumed to be sorted by `score` descending. RRF discards raw
 * scores and uses ranks only. Result is sorted by RRF score descending.
 * Ties preserve insertion order from the first occurrence across lists.
 */
export function fuseRecallLanes(lists: RecallCandidate[][]): FusedCandidate[] {
  const k = CONFIG.search.rrfK;
  const scores = new Map<string, number>();
  const candidates = new Map<string, RecallCandidate>();
  const order: string[] = [];

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const c = list[rank];
      const contribution = 1 / (k + rank + 1);
      scores.set(c.id, (scores.get(c.id) ?? 0) + contribution);
      if (!candidates.has(c.id)) {
        candidates.set(c.id, c);
        order.push(c.id);
      }
    }
  }

  return order
    .map(id => ({ ...(candidates.get(id) as RecallCandidate), rrfScore: scores.get(id) ?? 0 }))
    .sort((a, b) => {
      if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
      // Stable tiebreak: original insertion order.
      return order.indexOf(a.id) - order.indexOf(b.id);
    });
}
