/**
 * LongMemEval Retrieval Scoring
 *
 * For each question, runs Strata's search engine against the ingested haystack
 * and scores whether the correct evidence sessions are retrieved.
 *
 * Metrics:
 *   - Evidence Recall@K (K=5, 10, 20)
 *   - MRR (Mean Reciprocal Rank)
 *   - Latency (per-query and aggregate)
 */

import type Database from "better-sqlite3";
import type { SearchResult } from "../../src/search/sqlite-search-engine.js";
import type { IngestedQuestion } from "./ingest.js";
import { strataSessionIdToIndex } from "./ingest.js";
import type { LongMemQuestion, RetrievalResult } from "./types.js";
import { questionTypeToAbility } from "./types.js";
import { CONFIG } from "../../src/config.js";

// ---------------------------------------------------------------------------
// Date-range search for temporal reasoning (benchmark-only)
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const WORD_TO_NUM: Record<string, number> = {
  one: 1, a: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, twenty: 20, thirty: 30,
};

const DAY = 86400000;

function parseAnchorDate(dateStr: string): Date | null {
  const cleaned = dateStr.replace(/\s*\([A-Za-z]+\)\s*/, " ").trim();
  const d = new Date(cleaned);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Parse a temporal question into a [afterMs, beforeMs] date window.
 * Returns null if no date reference found.
 */
export function extractDateWindow(
  question: string,
  questionDate: string
): { afterMs: number; beforeMs: number } | null {
  const anchor = parseAnchorDate(questionDate);
  if (!anchor) return null;

  const qLower = question.toLowerCase();

  // "last [Weekday]"
  const dayMatch = question.match(/last\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i);
  if (dayMatch) {
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const target = dayNames.findIndex(d => d.toLowerCase() === dayMatch[1].toLowerCase());
    if (target >= 0) {
      let daysBack = (anchor.getDay() - target) % 7;
      if (daysBack <= 0) daysBack += 7;
      const dayStart = new Date(anchor.getTime() - daysBack * DAY);
      dayStart.setHours(0, 0, 0, 0);
      return { afterMs: dayStart.getTime() - DAY, beforeMs: dayStart.getTime() + 2 * DAY };
    }
  }

  // "yesterday"
  if (qLower.includes("yesterday")) {
    const yest = new Date(anchor.getTime() - DAY);
    yest.setHours(0, 0, 0, 0);
    return { afterMs: yest.getTime(), beforeMs: yest.getTime() + DAY };
  }

  // "last weekend"
  if (qLower.includes("last weekend")) {
    const satBack = ((anchor.getDay() + 1) % 7) || 7;
    const sat = new Date(anchor.getTime() - satBack * DAY);
    sat.setHours(0, 0, 0, 0);
    return { afterMs: sat.getTime(), beforeMs: sat.getTime() + 2 * DAY };
  }

  // "N days/weeks/months/years ago"
  const agoMatch = question.match(/(\d+|[a-z]+)\s+(day|week|month|year)s?\s+ago/i);
  if (agoMatch) {
    const rawN = agoMatch[1].toLowerCase();
    const n = rawN.match(/^\d+$/) ? parseInt(rawN) : WORD_TO_NUM[rawN];
    if (n !== undefined) {
      const unit = agoMatch[2].toLowerCase();
      const unitMs: Record<string, number> = {
        day: DAY, week: 7 * DAY, month: 30 * DAY, year: 365 * DAY,
      };
      const deltaMs = n * (unitMs[unit] ?? DAY);
      const center = anchor.getTime() - deltaMs;
      // Window: ±30 days for large periods, ±unit for small
      const halfWindow = Math.min(unitMs[unit] ?? DAY, 30 * DAY);
      return { afterMs: center - halfWindow, beforeMs: center + halfWindow };
    }
  }

  // "last/past N days/weeks/months"
  const lastNMatch = question.match(/(?:last|past|previous)\s+(\d+|[a-z]+)\s+(day|week|month|year)s?/i);
  if (lastNMatch) {
    const rawN = lastNMatch[1].toLowerCase();
    const n = rawN.match(/^\d+$/) ? parseInt(rawN) : WORD_TO_NUM[rawN];
    if (n !== undefined) {
      const unit = lastNMatch[2].toLowerCase();
      const unitMs: Record<string, number> = {
        day: DAY, week: 7 * DAY, month: 30 * DAY, year: 365 * DAY,
      };
      const deltaMs = n * (unitMs[unit] ?? DAY);
      return { afterMs: anchor.getTime() - deltaMs, beforeMs: anchor.getTime() };
    }
  }

  // "in [Month] [Year]"
  const monthYearMatch = question.match(
    /in\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i
  );
  if (monthYearMatch) {
    const monthIdx = MONTH_NAMES.findIndex(m => m.toLowerCase() === monthYearMatch[1].toLowerCase());
    const year = parseInt(monthYearMatch[2]);
    if (monthIdx >= 0) {
      return {
        afterMs: new Date(year, monthIdx, 1).getTime(),
        beforeMs: new Date(year, monthIdx + 1, 1).getTime() - 1,
      };
    }
  }

  // "in [Month]" (no year)
  const monthMatch = question.match(
    /in\s+(January|February|March|April|May|June|July|August|September|October|November|December)\b/i
  );
  if (monthMatch && !monthYearMatch) {
    const monthIdx = MONTH_NAMES.findIndex(m => m.toLowerCase() === monthMatch[1].toLowerCase());
    if (monthIdx >= 0) {
      const year = monthIdx <= anchor.getMonth() ? anchor.getFullYear() : anchor.getFullYear() - 1;
      return {
        afterMs: new Date(year, monthIdx, 1).getTime(),
        beforeMs: new Date(year, monthIdx + 1, 1).getTime() - 1,
      };
    }
  }

  return null;
}

/**
 * Search sessions by timestamp range. Direct SQL — not ranked, just filtered.
 */
export function searchByDateRange(
  db: Database.Database,
  afterMs: number,
  beforeMs: number,
  limit: number = 30
): Array<{ sessionId: string; timestamp: number; text: string }> {
  try {
    const rows = db.prepare(`
      SELECT session_id, timestamp, text
      FROM documents
      WHERE timestamp >= ? AND timestamp <= ?
      GROUP BY session_id
      ORDER BY timestamp ASC
      LIMIT ?
    `).all(afterMs, beforeMs, limit) as Array<{
      session_id: string; timestamp: number; text: string;
    }>;
    return rows.map(r => ({ sessionId: r.session_id, timestamp: r.timestamp, text: r.text }));
  } catch {
    return [];
  }
}

/**
 * Run retrieval for a single question against an ingested database.
 * Returns scored retrieval results with evidence recall and MRR.
 *
 * If `precomputedResults` is provided, uses those instead of calling searchAsync()
 * again. This avoids the two-call consistency bug where retrieval scoring and
 * answer context could see different orderings due to non-determinism.
 *
 * When `sessionScoring` is true, uses session-level DCG aggregation via
 * searchSessionLevel() instead of chunk-level searchAsync(). This allows
 * multi-chunk evidence signal to compound per session.
 */
export async function retrieveQuestion(
  question: LongMemQuestion,
  ingested: IngestedQuestion,
  precomputedResults?: SearchResult[],
  sessionScoring = false
): Promise<RetrievalResult & { searchResults: SearchResult[] }> {
  const start = performance.now();

  // Use precomputed results if provided, otherwise run search
  let results: SearchResult[];
  if (precomputedResults) {
    results = precomputedResults;
  } else if (sessionScoring) {
    // Use limit as sessionK for fair R@K comparison (not CONFIG.session.sessionTopK
    // which defaults to 10 and would cap R@20 artificially)
    results = await ingested.searchEngine.searchSessionLevel(
      question.question,
      { limit: 60, sessionK: 20 }
    );
  } else {
    results = await ingested.searchEngine.searchAsync(
      question.question,
      { limit: 20 }
    );
  }

  // NOTE: Date-range search was tested and HURT temporal (65.7% vs 71.4% without).
  // The broad windows add noise. Honcho's approach works because their agent queries
  // narrow windows interactively. Our blanket prepend doesn't help. Left as dead code
  // for future reference — needs narrower windows or agent-driven date filtering.

  // A6 (spec 2026-05-25-unified-turn-lane-surface §3.3): side-by-side
  // turn-lane retrieval. The engine knows how to do this now; the boost
  // fires automatically inside searchTurns when the classifier matches.
  // Populates the turnRecallAtK diagnostic on RetrievalResult; the session-
  // level result (above) is still the primary scoring path so the 81.08%
  // headline stays comparable.
  const turnHits = await ingested.searchEngine.searchTurns(question.question, {
    userId: undefined,
    project: undefined,
    limit: 20,
  });

  // Compute turn-lane recall@K against the gold session IDs.
  // Turn hits reference strata internal session IDs; map back to LongMemEval IDs.
  const goldSessionSet = new Set(question.answer_session_ids);
  const turnSessionsSeen = new Set<string>();
  let turnHitCount = 0;
  for (const hit of turnHits) {
    const idx = strataSessionIdToIndex(hit.row.sessionId);
    if (idx >= 0 && idx < ingested.indexToSessionId.length) {
      const longMemId = ingested.indexToSessionId[idx];
      if (!turnSessionsSeen.has(longMemId)) {
        turnSessionsSeen.add(longMemId);
        if (goldSessionSet.has(longMemId)) turnHitCount++;
      }
    }
  }
  const turnRecallAtK = goldSessionSet.size > 0 ? turnHitCount / goldSessionSet.size : 0;

  const latencyMs = precomputedResults ? 0 : performance.now() - start;

  // Map retrieved results back to LongMemEval session IDs
  // Deduplicate: multiple chunks from the same session should count once
  const seen = new Set<string>();
  const retrievedSessionIds: string[] = [];

  for (const result of results) {
    const idx = strataSessionIdToIndex(result.sessionId);
    if (idx >= 0 && idx < ingested.indexToSessionId.length) {
      const longMemId = ingested.indexToSessionId[idx];
      if (!seen.has(longMemId)) {
        seen.add(longMemId);
        retrievedSessionIds.push(longMemId);
      }
    }
  }

  const goldSessionIds = question.answer_session_ids;

  return {
    questionId: question.question_id,
    questionType: question.question_type,
    ability: questionTypeToAbility(question.question_type),
    retrievedSessionIds,
    goldSessionIds,
    evidenceRecall5: computeRecall(retrievedSessionIds, goldSessionIds, 5),
    evidenceRecall10: computeRecall(retrievedSessionIds, goldSessionIds, 10),
    evidenceRecall20: computeRecall(retrievedSessionIds, goldSessionIds, 20),
    mrr: computeMRR(retrievedSessionIds, goldSessionIds),
    latencyMs,
    turnRecallAtK,
    searchResults: results,
  };
}

/** Compute recall at K: what fraction of gold sessions appear in top-K retrieved */
function computeRecall(
  retrieved: string[],
  gold: string[],
  k: number
): number {
  if (gold.length === 0) return 1.0;
  const topK = new Set(retrieved.slice(0, k));
  const found = gold.filter((id) => topK.has(id)).length;
  return found / gold.length;
}

/** Compute Mean Reciprocal Rank: 1/(rank of first gold session in results) */
function computeMRR(retrieved: string[], gold: string[]): number {
  if (gold.length === 0) return 1.0;
  const goldSet = new Set(gold);
  for (let i = 0; i < retrieved.length; i++) {
    if (goldSet.has(retrieved[i])) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/** Compute aggregate retrieval metrics across all questions */
export function aggregateRetrieval(results: RetrievalResult[]): {
  evidenceRecall5: number;
  evidenceRecall10: number;
  evidenceRecall20: number;
  mrr: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
} {
  const n = results.length;
  if (n === 0) {
    return {
      evidenceRecall5: 0,
      evidenceRecall10: 0,
      evidenceRecall20: 0,
      mrr: 0,
      p50LatencyMs: 0,
      p95LatencyMs: 0,
    };
  }

  const recall5 = results.reduce((s, r) => s + r.evidenceRecall5, 0) / n;
  const recall10 = results.reduce((s, r) => s + r.evidenceRecall10, 0) / n;
  const recall20 = results.reduce((s, r) => s + r.evidenceRecall20, 0) / n;
  const mrr = results.reduce((s, r) => s + r.mrr, 0) / n;

  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);

  return {
    evidenceRecall5: recall5,
    evidenceRecall10: recall10,
    evidenceRecall20: recall20,
    mrr,
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}
