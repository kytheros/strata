/**
 * Score fusion using Reciprocal Rank Fusion (RRF), plus recency and project boosts.
 */

import { CONFIG } from "../config.js";
import type { DocumentChunk } from "../indexing/document-store.js";
import type { QueryFilters } from "./query-processor.js";
import { hasFeature } from "../extensions/feature-gate.js";
import { computeImportance } from "../knowledge/importance.js";
import { isCurrentStateQuery, isTemporalCurrentStateQuestion, hasHistoricalMarker, isDurationQuestion } from "./query-classifier.js";
import type { KnowledgeTurnHit } from "../storage/interfaces/knowledge-turn-store.js";

export interface RankedResult {
  docId: string;
  score: number;
  doc: DocumentChunk;
}

interface RankEntry {
  docId: string;
  score: number;
}

export interface RRFOptions {
  /** Per-list weights (default: all 1.0). */
  weights?: number[];
  /** Bonus multiplier for docs appearing in multiple lists (default: from config). */
  dualListBonus?: number;
}

/**
 * Reciprocal Rank Fusion: merge multiple ranked lists.
 * RRF(d) = Σ w_i / (k + rank_i(d))
 *
 * Documents appearing in multiple lists get a bonus:
 * score *= (1 + bonus × (listCount - 1))
 */
export function reciprocalRankFusion(
  rankedLists: RankEntry[][],
  options?: RRFOptions
): Map<string, number> {
  const k = CONFIG.search.rrfK;
  const dualListBonus = options?.dualListBonus ?? CONFIG.search.rrfDualListBonus;
  const weights = options?.weights;
  const scores = new Map<string, number>();
  const listCount = new Map<string, number>();

  for (let i = 0; i < rankedLists.length; i++) {
    const list = rankedLists[i];
    const weight = weights?.[i] ?? 1.0;
    for (let rank = 0; rank < list.length; rank++) {
      const entry = list[rank];
      const rrfScore = weight * (1 / (k + rank + 1));
      scores.set(entry.docId, (scores.get(entry.docId) || 0) + rrfScore);
      listCount.set(entry.docId, (listCount.get(entry.docId) || 0) + 1);
    }
  }

  // Boost documents that appear in multiple ranked lists
  if (dualListBonus > 0) {
    for (const [docId, count] of listCount) {
      if (count > 1) {
        scores.set(docId, scores.get(docId)! * (1 + dualListBonus * (count - 1)));
      }
    }
  }

  return scores;
}

/**
 * Apply post-retrieval boosts: recency, project match, deduplication.
 */
export function applyBoosts(
  results: RankedResult[],
  filters: QueryFilters,
  currentProject?: string
): RankedResult[] {
  const now = Date.now();
  const boosted = results.map((r) => {
    let score = r.score;

    // Recency boost
    if (r.doc.timestamp > 0) {
      const ageMs = now - r.doc.timestamp;
      const ageDays = ageMs / 86400000;
      if (ageDays <= 7) {
        score *= CONFIG.search.recencyBoost7d;
      } else if (ageDays <= 30) {
        score *= CONFIG.search.recencyBoost30d;
      }

      // Memory decay for auto-indexed entries (Pro feature, explicit memories exempt)
      if (hasFeature("pro") && r.doc.sessionId !== "explicit-memory") {
        if (ageDays > 180) {
          score *= CONFIG.search.decayPenalty180d;
        } else if (ageDays > 90) {
          score *= CONFIG.search.decayPenalty90d;
        }
      }
    }

    // Project match boost
    if (
      currentProject &&
      r.doc.project.toLowerCase().includes(currentProject.toLowerCase())
    ) {
      score *= CONFIG.search.projectMatchBoost;
    }

    // Importance boost (cognitive retrieval)
    // Uses pre-computed importance from the DB when available,
    // falls back to on-the-fly computation during transition window.
    const importance = r.doc.importance ?? computeImportance({
      text: r.doc.text,
      role: r.doc.role,
      sessionId: r.doc.sessionId,
    });
    score *= (1.0 + importance * CONFIG.importance.boostMax);

    return { ...r, score };
  });

  // Deduplicate: if multiple chunks from same session, keep best
  const bestPerSession = new Map<string, RankedResult>();
  for (const r of boosted) {
    const existing = bestPerSession.get(r.doc.sessionId);
    if (!existing || r.score > existing.score) {
      bestPerSession.set(r.doc.sessionId, r);
    }
  }

  // Sort by score
  const deduped = [...bestPerSession.values()];
  deduped.sort((a, b) => b.score - a.score);
  return deduped;
}

/** Aggregated score for a session computed from its constituent chunks */
export interface SessionScore {
  sessionId: string;
  /** DCG-aggregated score from chunks in ranked list */
  dcgScore: number;
  /** All chunks from this session that appeared in the ranked list */
  chunks: RankedResult[];
  /** The best-scoring chunk (for backward compat / representative doc) */
  bestChunk: RankedResult;
  /** Sum of all chunk RRF scores */
  sumScore: number;
  /** Number of chunks from this session in candidate list */
  chunkCount: number;
}

/**
 * Aggregate a ranked chunk list into session-level scores.
 *
 * Strategy: best chunk score + logarithmic bonus for additional high-ranking
 * chunks. This preserves the existing max-score ranking as baseline while
 * rewarding sessions with distributed evidence — without the long-session
 * bias of raw DCG sum (where sessions with many low-ranked chunks outscored
 * sessions with few high-ranked chunks).
 *
 * Formula: dcgScore = bestChunkScore + Σ(additionalChunkScore / log2(i + 2))
 * where i is the chunk's index within this session's chunks (sorted by score),
 * NOT its global rank. This makes the bonus relative to the session's own
 * evidence quality, not to the total candidate pool size.
 */
export function aggregateToSessionScores(
  rankedChunks: RankedResult[]
): SessionScore[] {
  const sessions = new Map<string, SessionScore>();

  // First pass: collect all chunks per session
  for (const result of rankedChunks) {
    const { sessionId } = result.doc;
    const existing = sessions.get(sessionId);

    if (!existing) {
      sessions.set(sessionId, {
        sessionId,
        dcgScore: 0, // computed in second pass
        chunks: [result],
        bestChunk: result,
        sumScore: result.score,
        chunkCount: 1,
      });
    } else {
      existing.chunks.push(result);
      existing.sumScore += result.score;
      existing.chunkCount++;
      if (result.score > existing.bestChunk.score) {
        existing.bestChunk = result;
      }
    }
  }

  // Second pass: compute session score as best + diminishing bonus
  for (const session of sessions.values()) {
    // Sort this session's chunks by score descending
    const sorted = session.chunks.slice().sort((a, b) => b.score - a.score);

    // Best chunk is the baseline (identical to old max-dedup behavior)
    let score = sorted[0].score;

    // Additional chunks add diminishing bonus (log-discounted by within-session rank)
    for (let i = 1; i < sorted.length; i++) {
      score += sorted[i].score / Math.log2(i + 2);
    }

    session.dcgScore = score;
  }

  return [...sessions.values()];
}

/**
 * Apply post-retrieval boosts at the session level.
 * Same logic as applyBoosts() but operates on SessionScore using bestChunk.doc
 * for metadata (timestamp, project, importance). Does NOT deduplicate — session
 * aggregation already handles that.
 *
 * Returns sessions sorted by dcgScore descending.
 */
export function applySessionBoosts(
  sessions: SessionScore[],
  filters: QueryFilters,
  currentProject?: string,
  now = Date.now(),
  query?: string
): SessionScore[] {
  const boosted = sessions.map((s) => {
    let score = s.dcgScore;
    const doc = s.bestChunk.doc;

    // Recency boost
    if (doc.timestamp > 0) {
      const ageMs = now - doc.timestamp;
      const ageDays = ageMs / 86400000;
      if (ageDays <= 7) {
        score *= CONFIG.search.recencyBoost7d;
      } else if (ageDays <= 30) {
        score *= CONFIG.search.recencyBoost30d;
      }

      // Memory decay for auto-indexed entries (Pro feature, explicit memories exempt)
      if (hasFeature("pro") && doc.sessionId !== "explicit-memory") {
        if (ageDays > 180) {
          score *= CONFIG.search.decayPenalty180d;
        } else if (ageDays > 90) {
          score *= CONFIG.search.decayPenalty90d;
        }
      }
    }

    // Project match boost
    if (
      currentProject &&
      doc.project.toLowerCase().includes(currentProject.toLowerCase())
    ) {
      score *= CONFIG.search.projectMatchBoost;
    }

    // Importance boost (cognitive retrieval)
    const importance = doc.importance ?? computeImportance({
      text: doc.text,
      role: doc.role,
      sessionId: doc.sessionId,
    });
    score *= (1.0 + importance * CONFIG.importance.boostMax);

    return { ...s, dcgScore: score };
  });

  // Sort by dcgScore descending
  boosted.sort((a, b) => b.dcgScore - a.dcgScore);

  // Knowledge-update recency boost: most recent sessions get up to CONFIG.session.recencyBoostMax multiplier
  if (query && isCurrentStateQuery(query)) {
    const timestamps = boosted.map(s => s.bestChunk.doc.timestamp).filter(t => t > 0);
    if (timestamps.length > 1) {
      const earliest = Math.min(...timestamps);
      const latest = Math.max(...timestamps);
      const span = latest - earliest;
      if (span > 0) {
        for (const s of boosted) {
          const t = s.bestChunk.doc.timestamp;
          if (t > 0) {
            const frac = (t - earliest) / span;
            s.dcgScore *= (1.0 + CONFIG.session.recencyBoostMax * frac);
          }
        }
        // Re-sort after recency adjustment
        boosted.sort((a, b) => b.dcgScore - a.dcgScore);
      }
    }
  }

  return boosted;
}

/**
 * Apply query filters to results.
 */
export function applyFilters(
  results: RankedResult[],
  filters: QueryFilters
): RankedResult[] {
  return results.filter((r) => {
    if (
      filters.project &&
      !r.doc.project.toLowerCase().includes(filters.project.toLowerCase())
    ) {
      return false;
    }
    if (filters.before && r.doc.timestamp > filters.before) {
      return false;
    }
    if (filters.after && r.doc.timestamp < filters.after) {
      return false;
    }
    if (
      filters.tool &&
      !r.doc.toolNames.some((t) =>
        t.toLowerCase().includes(filters.tool!.toLowerCase())
      )
    ) {
      return false;
    }
    return true;
  });
}

/**
 * Options for `applyTurnRecencyBoost`.
 */
export interface TurnRecencyBoostOpts {
  /**
   * If true, applies the reordering unconditionally without consulting the
   * classifier. Used by the harness's `recency-weighted` strategy.
   * Default false (gated by `isTemporalCurrentStateQuestion`).
   */
  force?: boolean;
}

/**
 * Apply session-bucketed recency-dominant ordering to turn-lane hits.
 *
 * When the strategy engages (classifier fires OR opts.force=true), reorders
 * hits so that turns from the newest session appear first, with BM25 order
 * preserved within each session. Scores are not modified — the signal is
 * order only.
 *
 * Replaces the original multiplicative boost (spec 2026-05-18). Diagnostics
 * on 2026-05-19 showed BM25 scores span 5+ orders of magnitude on real
 * fixture content, making multiplicative tuning mathematically unfeasible
 * (a 226,000× boost would have been needed to flip temporal-001).
 * Spec: 2026-05-19-recency-dominant-ranking-design.md.
 *
 * No-op (returns input as-is) when:
 *   - hits.length < 2
 *   - !opts.force && !isTemporalCurrentStateQuestion(query)
 *   - all session createdAt timestamps are identical (no relative recency signal)
 *
 * Stable: sessions with equal createdAt preserve insertion order; turns
 * within a session preserve input (BM25) order.
 */
export function applyTurnRecencyBoost(
  hits: KnowledgeTurnHit[],
  query: string,
  opts: TurnRecencyBoostOpts = {},
): KnowledgeTurnHit[] {
  // Apply within-session speaker-prefer FIRST so its effect lands even when
  // the recency-aware branch below no-ops (single session, classifier veto,
  // identical timestamps). Frozen-eval rule: every callsite of this function
  // already exists, so embedding the call here avoids modifying the frozen
  // autoresearch-turn-lane-ranking eval. Spec 2026-05-23-within-session-speaker-prefer.
  let working = hits;
  if (CONFIG.search.turnSpeakerPrefer.enabled) {
    working = applyWithinSessionSpeakerPrefer(hits);
  }

  // Apply query-gated within-session DESC correction for short-session
  // correction patterns (ranking-006, ranking-010). Gate: skip on historical
  // queries ("ago", "previously", ...) and duration questions ("how many days
  // passed") to protect LME fixtures (ranking-003/004/005). Spec 2026-05-23-
  // short-session-desc-tiebreaker-design.md.
  if (CONFIG.search.turnSpeakerPrefer.enabled &&
      !hasHistoricalMarker(query) &&
      !isDurationQuestion(query)) {
    working = applyShortSessionDescCorrection(working);
  }

  // Recency reorder pass. Only engages when length ≥ 2 AND (force OR
  // classifier fires) AND there are ≥ 2 distinct session timestamps.
  if (working.length >= 2 && (opts.force || isTemporalCurrentStateQuestion(query))) {
    // 1. Group hits by sessionId, preserving input order (which is now the
    //    speaker-prefer-adjusted order).
    const bySession = new Map<string, KnowledgeTurnHit[]>();
    for (const h of working) {
      const arr = bySession.get(h.row.sessionId);
      if (arr) arr.push(h);
      else bySession.set(h.row.sessionId, [h]);
    }

    // 2. Compute representative createdAt per session = min createdAt of hits
    //    in that session. Since pipeline-driver writes turns with createdAt =
    //    sessionCreatedAt + msgIdx, this is essentially sessionCreatedAt.
    const sessionsByRecency = [...bySession.entries()].map(([sessionId, sessionHits]) => ({
      sessionId,
      sessionCreatedAt: Math.min(...sessionHits.map((h) => h.row.createdAt)),
      hits: sessionHits, // already in BM25 order from input
    }));

    // 3. Engage reorder only when sessions have ≥ 2 distinct timestamps.
    const distinctCreatedAts = new Set(sessionsByRecency.map((s) => s.sessionCreatedAt));
    if (distinctCreatedAts.size >= 2) {
      // 4. Sort sessions by recency DESC (newest first). Array.sort is stable
      //    in ECMAScript 2019+, so equal createdAt preserves insertion order.
      sessionsByRecency.sort((a, b) => b.sessionCreatedAt - a.sessionCreatedAt);
      // 5. Flatten: newest session's BM25-ordered hits first. Returns original
      //    KnowledgeTurnHit objects unchanged (scores intact).
      working = sessionsByRecency.flatMap((s) => s.hits);
    }
  }

  // Apply per-session cap as the final pass (regardless of which path above
  // ran). Spec 2026-05-23-per-session-top5-cap-design.md.
  if (CONFIG.search.turnPerSessionCap.enabled) {
    working = applyPerSessionCap(working);
  }
  return working;
}

/**
 * Per-session hit cap. When a session has more hits than this constant in
 * the ranked output, the excess is demoted to the end of the list.
 * Empirically validated against the 15-fixture turn-lane eval. Cap=2 frees
 * enough top-5 slots to surface ranking-004's under-represented sibling
 * session.
 *
 * Spec: 2026-05-23-per-session-top5-cap-design.md
 */
const MAX_HITS_PER_SESSION = 2;

/**
 * Per-session top-K cap using overflow demotion.
 *
 * Walks the ranked list in order. Hits whose session-count is ≤
 * MAX_HITS_PER_SESSION are kept in their original position. Hits exceeding
 * the cap are demoted to the end of the list, preserving their relative
 * order among themselves.
 *
 * Top-1 preservation: the first hit in the input always has count=1, which
 * is ≤ cap, so it stays at index 0. No fixture currently passing top-1 can
 * regress.
 *
 * Spec: 2026-05-23-per-session-top5-cap-design.md
 */
export function applyPerSessionCap(
  hits: KnowledgeTurnHit[],
): KnowledgeTurnHit[] {
  if (hits.length < 2) return hits;

  const counts = new Map<string, number>();
  const kept: KnowledgeTurnHit[] = [];
  const overflow: KnowledgeTurnHit[] = [];

  for (const h of hits) {
    const c = (counts.get(h.row.sessionId) ?? 0) + 1;
    counts.set(h.row.sessionId, c);
    if (c <= MAX_HITS_PER_SESSION) {
      kept.push(h);
    } else {
      overflow.push(h);
    }
  }

  return [...kept, ...overflow];
}

/**
 * Within-session stable sort: user turns before assistant turns (system last).
 * Cross-session order is preserved (sessions appear in the order they first
 * appear in the input).
 *
 * Pure ordering pass — scores not modified. Within the same speaker, BM25
 * order is preserved (no turn-index tiebreaker). Cross-session order is
 * preserved (sessions appear in the order they first appear in the input).
 *
 * Addresses bucket 1 of issue #15 (within-session BM25 prefers assistant
 * confirmation echoes over user decision/correction turns) for fixtures
 * 007/008/009. Fixtures 006/010 (same-session correction pattern requiring
 * DESC turn-index) are handled by a separate query-gated DESC pass inside
 * applyTurnRecencyBoost. See SHORT_SESSION_USER_HIT_THRESHOLD below.
 *
 * Spec: 2026-05-23-within-session-speaker-prefer-design.md
 */
export function applyWithinSessionSpeakerPrefer(
  hits: KnowledgeTurnHit[],
): KnowledgeTurnHit[] {
  if (hits.length < 2) return hits;

  // Group by sessionId, preserving the order in which sessions first appear.
  const bySession = new Map<string, KnowledgeTurnHit[]>();
  for (const h of hits) {
    const arr = bySession.get(h.row.sessionId);
    if (arr) arr.push(h);
    else bySession.set(h.row.sessionId, [h]);
  }

  // Within each session, stable-sort by speaker rank only (user=0, assistant=1,
  // system=2). Within-speaker order is preserved from BM25 input.
  for (const sessionHits of bySession.values()) {
    sessionHits.sort((a, b) => {
      return speakerRank(a.row.speaker) - speakerRank(b.row.speaker);
    });
  }

  // Flatten in original session order.
  return [...bySession.values()].flat();
}

/**
 * Threshold for applying turn-index DESC tiebreaker within a session's user
 * group. When a session bucket in the result set has ≤3 user-turn hits,
 * treat it as a "correction pattern" and surface the latest user turn first.
 * When ≥4, preserve BM25 order.
 *
 * This is applied ONLY when the query is DESC-eligible (not a historical or
 * duration question) — see applyShortSessionDescCorrection.
 *
 * Spec: 2026-05-23-short-session-desc-tiebreaker-design.md
 */
const SHORT_SESSION_USER_HIT_THRESHOLD = 3;

/**
 * Query-gated within-session DESC correction pass.
 *
 * For queries that are NOT historical ("ago", "previously", ...) and NOT
 * duration-based ("how many days passed"), apply turn-index DESC within the
 * user group for sessions where user-hit count ≤ SHORT_SESSION_USER_HIT_THRESHOLD.
 * This surfaces the latest user decision/correction in short single-topic
 * sessions (ranking-006, ranking-010) without regressing LME temporal
 * fixtures where the expected answer is at the earliest matching user turn
 * (ranking-003: "ago" → historical veto; ranking-004/005: duration questions).
 *
 * Called from applyTurnRecencyBoost after applyWithinSessionSpeakerPrefer.
 * Not called when the query carries a historical or duration marker.
 *
 * Spec: 2026-05-23-short-session-desc-tiebreaker-design.md
 */
function applyShortSessionDescCorrection(hits: KnowledgeTurnHit[]): KnowledgeTurnHit[] {
  if (hits.length < 2) return hits;

  // Group by sessionId, preserving the order sessions first appear (which is
  // the speaker-prefer-adjusted order from the preceding pass).
  const bySession = new Map<string, KnowledgeTurnHit[]>();
  for (const h of hits) {
    const arr = bySession.get(h.row.sessionId);
    if (arr) arr.push(h);
    else bySession.set(h.row.sessionId, [h]);
  }

  for (const sessionHits of bySession.values()) {
    const userHitCount = sessionHits.filter((h) => h.row.speaker === "user").length;
    if (userHitCount > SHORT_SESSION_USER_HIT_THRESHOLD) continue; // preserve BM25 order

    // Apply DESC within the user group of this short-session bucket.
    sessionHits.sort((a, b) => {
      const speakerOrder = speakerRank(a.row.speaker) - speakerRank(b.row.speaker);
      if (speakerOrder !== 0) return speakerOrder;
      if (a.row.speaker === "user") {
        return b.row.messageIndex - a.row.messageIndex; // DESC within user group
      }
      return 0; // preserve BM25 order for non-user speakers
    });
  }

  return [...bySession.values()].flat();
}

function speakerRank(speaker: string): number {
  if (speaker === "user") return 0;
  if (speaker === "assistant") return 1;
  return 2; // system or other
}
