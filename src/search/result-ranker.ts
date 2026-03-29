/**
 * Score fusion using Reciprocal Rank Fusion (RRF), plus recency and project boosts.
 */

import { CONFIG } from "../config.js";
import type { DocumentChunk } from "../indexing/document-store.js";
import type { QueryFilters } from "./query-processor.js";
import { hasFeature } from "../extensions/feature-gate.js";
import { computeImportance } from "../knowledge/importance.js";
import { isCurrentStateQuery } from "./query-classifier.js";

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
