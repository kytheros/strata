/**
 * recall-fusion-community — Thin Community-surface wrapper around the RRF
 * fusion math in `src/transports/recall-fusion.ts`.
 *
 * The NPC recall pipeline (recall-fusion.ts) fuses `npc_turns` rows and
 * `npc_memories` rows using Reciprocal Rank Fusion with `rrfK=40`. This
 * module re-uses the identical RRF math but adapts the input/output shapes to
 * the Community surface:
 *
 *   Input lane A — CommunityChunkResult[]  (knowledge_chunks / knowledge FTS hits)
 *   Input lane B — KnowledgeTurnHit[]      (knowledge_turns FTS hits, TIRQDP-1.2)
 *   Output       — FusedResult[]           carries `project` + `userId` through
 *
 * The RRF math itself (the loop body, rank formula, score accumulation, and
 * sort) is byte-identical to fuseRecallLanes.  Any divergence is a bug.
 *
 * Pure function. No internal state, no cache (D2).
 *
 * Spec: 2026-05-01-tirqdp-community-port-plan.md §TIRQDP-1.4
 * Ticket: TIRQDP-1.4
 */

import { CONFIG } from "../config.js";
import type { KnowledgeTurnHit } from "../storage/interfaces/knowledge-turn-store.js";

// ── Input types ──────────────────────────────────────────────────────────────

/**
 * A pre-ranked knowledge chunk or FTS search hit from the Community
 * knowledge store (knowledge_chunks / search-engine results).
 */
export interface CommunityChunkResult {
  /** Stable identifier — chunk_id, row_id, or any unique key. */
  id: string;
  /** Pre-fusion relevance score (higher = more relevant). List must be sorted
   *  descending by this value before passing to fuseCommunityLanes. */
  score: number;
  /** User/tenant that owns this result. Carried through to FusedResult. */
  userId: string | null;
  /** Project that owns this result. Carried through to FusedResult. */
  project: string | null;
  /** Raw text content for downstream QDP filtering + projection. */
  content: string;
  /** Source tags (e.g. language hints, importance markers). Used by QDP filler
   *  filter. */
  tags: string[];
}

// ── Output type ───────────────────────────────────────────────────────────────

export type FusedSource = "chunk" | "turn";

/** A fused candidate carrying the original payload plus its RRF score. */
export interface FusedResult {
  /** The stable identifier from the originating lane. */
  id: string;
  /** Fused RRF score. Higher = more relevant across all lanes. */
  rrfScore: number;
  /** Which lane this candidate originated from. */
  source: FusedSource;
  /** Raw text content. */
  content: string;
  /** Tags from the source record. */
  tags: string[];
  /** Multi-tenant user scope, carried through from the originating hit. */
  userId: string | null;
  /** Project scope, carried through from the originating hit. */
  project: string | null;
  /** Epoch ms timestamp for recency sort by downstream consumers. */
  createdAt: number;
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface FuseCommunityLanesOpts {
  /**
   * RRF constant k. Defaults to CONFIG.search.rrfK (40, AutoResearch-optimised).
   * Override in tests to verify denominator math without coupling to config.
   */
  rrfK?: number;
}

// ── Core function ─────────────────────────────────────────────────────────────

/**
 * Fuse a chunk lane and a turn lane via Reciprocal Rank Fusion.
 *
 * Each list must be sorted by `score` descending (callers are responsible).
 * RRF discards raw scores and uses only ranks. Ties in RRF score preserve
 * insertion order (chunk lane first, then turn lane).
 *
 * @param chunkResults  Pre-ranked knowledge chunk / FTS hits (lane A).
 * @param turnResults   Pre-ranked KnowledgeTurnHit results (lane B).
 * @param opts          Optional overrides (rrfK).
 * @returns             Merged list sorted by rrfScore descending.
 */
export function fuseCommunityLanes(
  chunkResults: CommunityChunkResult[],
  turnResults: KnowledgeTurnHit[],
  opts: FuseCommunityLanesOpts
): FusedResult[] {
  const k = opts.rrfK ?? CONFIG.search.rrfK;

  // Adapt both lanes into a unified shape so the RRF loop is a single pass.
  // This mirrors the structure of fuseRecallLanes exactly; the only difference
  // is that we carry extra fields (userId, project, createdAt, source) through.

  interface Candidate {
    id: string;
    source: FusedSource;
    content: string;
    tags: string[];
    userId: string | null;
    project: string | null;
    createdAt: number;
  }

  // Build two lists of (id, payload) pairs — one per lane.
  const chunkList: Candidate[] = chunkResults.map(c => ({
    id: c.id,
    source: "chunk" as FusedSource,
    content: c.content,
    tags: c.tags,
    userId: c.userId,
    project: c.project,
    createdAt: 0,
  }));

  const turnList: Candidate[] = turnResults.map(h => ({
    id: h.row.turnId,
    source: "turn" as FusedSource,
    content: h.row.content,
    tags: [],
    userId: h.row.userId,
    project: h.row.project,
    createdAt: h.row.createdAt,
  }));

  // ── RRF math — byte-identical to fuseRecallLanes ─────────────────────────
  // Do NOT modify this block without re-running the AutoResearch evals.
  const scores = new Map<string, number>();
  const candidates = new Map<string, Candidate>();
  const order: string[] = [];

  for (const list of [chunkList, turnList]) {
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
    .map(id => ({
      ...(candidates.get(id) as Candidate),
      rrfScore: scores.get(id) ?? 0,
    }))
    .sort((a, b) => {
      if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
      // Stable tiebreak: original insertion order.
      return order.indexOf(a.id) - order.indexOf(b.id);
    });
}
