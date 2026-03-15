/**
 * Evidence gap tracking: detect, persist, and resolve knowledge blind spots.
 *
 * When a search returns no results or low-confidence results, a "gap" is recorded.
 * When new knowledge is stored (via store_memory), open gaps are checked for resolution
 * using Jaccard similarity between the gap's query tokens and the entry's summary+tags.
 *
 * Gaps are deduplicated by normalized query key (stemmed, sorted, word-order independent).
 * Pruning runs lazily on each recordGap() call — not on a timer.
 */

import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import type { KnowledgeEntry } from "../knowledge/knowledge-store.js";
import { stemmedWords, jaccardSimilarity } from "../knowledge/learning-synthesizer.js";
import { CONFIG } from "../config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EvidenceGap {
  id: string;
  query: string;
  tool: string;
  project: string;
  user: string;
  resultCount: number;
  topScore: number | null;
  topConfidence: number | null;
  occurredAt: number;
  resolvedAt: number | null;
  resolutionId: string | null;
  occurrenceCount: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a query into a deterministic gap key.
 * Uses stemmed words sorted alphabetically so word order doesn't matter.
 * "redis caching strategy" and "strategy caching redis" produce the same key.
 */
export function normalizeGapKey(query: string): string {
  const tokens = stemmedWords(query);
  return [...tokens].sort().join(" ");
}

/**
 * Prune old and excess gaps.
 * - Delete unresolved gaps older than CONFIG.gaps.pruneAfterDays
 * - Enforce CONFIG.gaps.maxPerProject cap per project+user (keep most recent)
 */
function pruneGaps(db: Database.Database, project: string, user: string): void {
  const maxAge = CONFIG.gaps.pruneAfterDays * 86400000;
  const cutoff = Date.now() - maxAge;

  // Prune by age (unresolved only)
  db.prepare(
    `DELETE FROM evidence_gaps WHERE resolved_at IS NULL AND occurred_at < ? AND user = ?`
  ).run(cutoff, user);

  // Prune by count: keep most recent N per project+user (unresolved only)
  db.prepare(`
    DELETE FROM evidence_gaps WHERE id IN (
      SELECT id FROM evidence_gaps
      WHERE project = ? AND user = ? AND resolved_at IS NULL
      ORDER BY occurred_at DESC
      LIMIT -1 OFFSET ?
    )
  `).run(project, user, CONFIG.gaps.maxPerProject);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record an evidence gap when a search returns empty or low-confidence results.
 *
 * If an unresolved gap with the same normalized query, project, and user already
 * exists, its occurrence_count is incremented. Otherwise, a new gap row is inserted.
 *
 * Pruning runs after every recording to enforce age and count limits.
 */
export function recordGap(db: Database.Database, args: {
  query: string;
  tool: string;
  project?: string;
  user: string;
  resultCount: number;
  topScore: number | null;
  topConfidence: number | null;
}): void {
  const gapKey = normalizeGapKey(args.query);
  const project = args.project ?? "";

  const existing = db.prepare(
    `SELECT id, occurrence_count FROM evidence_gaps
     WHERE query = ? AND project = ? AND user = ? AND resolved_at IS NULL`
  ).get(gapKey, project, args.user) as { id: string; occurrence_count: number } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE evidence_gaps SET occurrence_count = occurrence_count + 1,
       occurred_at = ?, top_score = ?, top_confidence = ?
       WHERE id = ?`
    ).run(Date.now(), args.topScore, args.topConfidence, existing.id);
  } else {
    db.prepare(
      `INSERT INTO evidence_gaps (id, query, tool, project, user, result_count,
       top_score, top_confidence, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(), gapKey, args.tool, project, args.user,
      args.resultCount, args.topScore, args.topConfidence, Date.now()
    );
  }

  pruneGaps(db, project, args.user);
}

/**
 * Check if any open gaps are resolved by a newly stored knowledge entry.
 *
 * Compares the entry's stemmed summary+tags against each open gap's stemmed query.
 * If Jaccard similarity >= CONFIG.gaps.resolutionThreshold (default 0.4),
 * the gap is marked resolved.
 *
 * @returns The number of gaps resolved.
 */
export function resolveGaps(db: Database.Database, entry: KnowledgeEntry): number {
  const entryTokens = stemmedWords(`${entry.summary} ${entry.tags.join(" ")}`);
  const project = entry.project ?? "";
  const user = entry.user ?? "default";

  const openGaps = db.prepare(
    `SELECT id, query FROM evidence_gaps
     WHERE (project = ? OR project = '') AND user = ? AND resolved_at IS NULL`
  ).all(project, user) as { id: string; query: string }[];

  let resolved = 0;
  for (const gap of openGaps) {
    const gapTokens = stemmedWords(gap.query);
    if (jaccardSimilarity(entryTokens, gapTokens) >= CONFIG.gaps.resolutionThreshold) {
      db.prepare(
        `UPDATE evidence_gaps SET resolved_at = ?, resolution_id = ? WHERE id = ?`
      ).run(Date.now(), entry.id, gap.id);
      resolved++;
    }
  }
  return resolved;
}

/**
 * Query the evidence_gaps table with optional filters.
 *
 * @param args.status - "open" (unresolved), "resolved", or "all"
 * @param args.minOccurrences - Minimum occurrence_count to include
 * @param args.limit - Max rows to return (default 50)
 */
export function listGaps(db: Database.Database, args: {
  project?: string;
  user?: string;
  status?: "open" | "resolved" | "all";
  minOccurrences?: number;
  limit?: number;
}): EvidenceGap[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (args.project) {
    conditions.push("project = ?");
    params.push(args.project);
  }

  if (args.user) {
    conditions.push("user = ?");
    params.push(args.user);
  }

  const status = args.status ?? "open";
  if (status === "open") {
    conditions.push("resolved_at IS NULL");
  } else if (status === "resolved") {
    conditions.push("resolved_at IS NOT NULL");
  }
  // "all" — no filter on resolved_at

  if (args.minOccurrences && args.minOccurrences > 1) {
    conditions.push("occurrence_count >= ?");
    params.push(args.minOccurrences);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = args.limit ?? 50;

  const rows = db.prepare(
    `SELECT id, query, tool, project, user, result_count, top_score, top_confidence,
            occurred_at, resolved_at, resolution_id, occurrence_count
     FROM evidence_gaps ${where}
     ORDER BY occurred_at DESC
     LIMIT ?`
  ).all(...params, limit) as {
    id: string;
    query: string;
    tool: string;
    project: string;
    user: string;
    result_count: number;
    top_score: number | null;
    top_confidence: number | null;
    occurred_at: number;
    resolved_at: number | null;
    resolution_id: string | null;
    occurrence_count: number;
  }[];

  return rows.map((r) => ({
    id: r.id,
    query: r.query,
    tool: r.tool,
    project: r.project,
    user: r.user,
    resultCount: r.result_count,
    topScore: r.top_score,
    topConfidence: r.top_confidence,
    occurredAt: r.occurred_at,
    resolvedAt: r.resolved_at,
    resolutionId: r.resolution_id,
    occurrenceCount: r.occurrence_count,
  }));
}

/**
 * Look up the occurrence count for a matching open gap.
 * Used by search handlers to generate gap-aware nudge messages.
 *
 * @returns The occurrence_count if a matching gap exists, or 0.
 */
export function getGapOccurrences(db: Database.Database, query: string, project: string, user: string): number {
  const gapKey = normalizeGapKey(query);
  const row = db.prepare(
    `SELECT occurrence_count FROM evidence_gaps
     WHERE query = ? AND project = ? AND user = ? AND resolved_at IS NULL`
  ).get(gapKey, project, user) as { occurrence_count: number } | undefined;
  return row?.occurrence_count ?? 0;
}

/**
 * Gap summary statistics for dashboard.
 */
export function getGapSummary(db: Database.Database, project?: string): {
  openCount: number;
  resolvedCount: number;
  avgTimeToResolution: number;
  mostPersistentGap: EvidenceGap | null;
} {
  const projectCondition = project ? " AND project = ?" : "";
  const projectParams: string[] = project ? [project] : [];

  const openRow = db.prepare(
    `SELECT COUNT(*) as count FROM evidence_gaps WHERE resolved_at IS NULL${projectCondition}`
  ).get(...projectParams) as { count: number };

  const resolvedRow = db.prepare(
    `SELECT COUNT(*) as count FROM evidence_gaps WHERE resolved_at IS NOT NULL${projectCondition}`
  ).get(...projectParams) as { count: number };

  const avgRow = db.prepare(
    `SELECT AVG(resolved_at - occurred_at) as avg_time FROM evidence_gaps WHERE resolved_at IS NOT NULL${projectCondition}`
  ).get(...projectParams) as { avg_time: number | null };

  const persistentRow = db.prepare(
    `SELECT id, query, tool, project, user, result_count, top_score, top_confidence,
            occurred_at, resolved_at, resolution_id, occurrence_count
     FROM evidence_gaps WHERE resolved_at IS NULL${projectCondition}
     ORDER BY occurrence_count DESC LIMIT 1`
  ).get(...projectParams) as {
    id: string;
    query: string;
    tool: string;
    project: string;
    user: string;
    result_count: number;
    top_score: number | null;
    top_confidence: number | null;
    occurred_at: number;
    resolved_at: number | null;
    resolution_id: string | null;
    occurrence_count: number;
  } | undefined;

  return {
    openCount: openRow.count,
    resolvedCount: resolvedRow.count,
    avgTimeToResolution: avgRow.avg_time ?? 0,
    mostPersistentGap: persistentRow
      ? {
          id: persistentRow.id,
          query: persistentRow.query,
          tool: persistentRow.tool,
          project: persistentRow.project,
          user: persistentRow.user,
          resultCount: persistentRow.result_count,
          topScore: persistentRow.top_score,
          topConfidence: persistentRow.top_confidence,
          occurredAt: persistentRow.occurred_at,
          resolvedAt: persistentRow.resolved_at,
          resolutionId: persistentRow.resolution_id,
          occurrenceCount: persistentRow.occurrence_count,
        }
      : null,
  };
}

/**
 * Dismiss a gap (mark as irrelevant by user).
 * Uses resolved_at + resolution_id = 'dismissed' as a convention
 * until a dedicated dismissed_at column is added via migration.
 */
export function dismissGap(db: Database.Database, gapId: string): void {
  db.prepare(
    "UPDATE evidence_gaps SET resolved_at = ?, resolution_id = 'dismissed' WHERE id = ?"
  ).run(Date.now(), gapId);
}
