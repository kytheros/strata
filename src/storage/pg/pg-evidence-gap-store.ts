/**
 * Postgres-backed evidence gap store.
 *
 * Implements IEvidenceGapStore for Postgres.
 * Port of evidence-gaps.ts functions to async pg interface.
 */

import type { PgPool } from "./pg-types.js";
import type { IEvidenceGapStore } from "../interfaces/evidence-gap-store.js";
import type { EvidenceGap } from "../../search/evidence-gaps.js";
import type { KnowledgeEntry } from "../../knowledge/knowledge-store.js";
import { normalizeGapKey } from "../../search/evidence-gaps.js";
import { stemmedWords, jaccardSimilarity } from "../../knowledge/learning-synthesizer.js";
import { CONFIG } from "../../config.js";
import { randomUUID } from "crypto";

interface PgGapRow {
  id: string;
  query: string;
  tool: string;
  project: string;
  user_scope: string;
  result_count: number;
  top_score: number | null;
  top_confidence: number | null;
  occurred_at: string;
  resolved_at: string | null;
  resolution_id: string | null;
  occurrence_count: number;
}

function rowToGap(row: PgGapRow): EvidenceGap {
  return {
    id: row.id,
    query: row.query,
    tool: row.tool,
    project: row.project,
    user: row.user_scope,
    resultCount: row.result_count,
    topScore: row.top_score,
    topConfidence: row.top_confidence,
    occurredAt: Number(row.occurred_at),
    resolvedAt: row.resolved_at ? Number(row.resolved_at) : null,
    resolutionId: row.resolution_id,
    occurrenceCount: row.occurrence_count,
  };
}

export class PgEvidenceGapStore implements IEvidenceGapStore {
  constructor(private pool: PgPool) {}

  async recordGap(args: {
    query: string;
    tool: string;
    project?: string;
    user: string;
    resultCount: number;
    topScore: number | null;
    topConfidence: number | null;
  }): Promise<void> {
    const gapKey = normalizeGapKey(args.query);
    const project = args.project ?? "";

    const { rows: existingRows } = await this.pool.query<{ id: string; occurrence_count: number }>(
      `SELECT id, occurrence_count FROM evidence_gaps
       WHERE query = $1 AND project = $2 AND user_scope = $3 AND resolved_at IS NULL`,
      [gapKey, project, args.user]
    );

    if (existingRows.length > 0) {
      await this.pool.query(
        `UPDATE evidence_gaps SET occurrence_count = occurrence_count + 1,
         occurred_at = $1, top_score = $2, top_confidence = $3
         WHERE id = $4`,
        [Date.now(), args.topScore, args.topConfidence, existingRows[0].id]
      );
    } else {
      await this.pool.query(
        `INSERT INTO evidence_gaps (id, query, tool, project, user_scope, result_count,
         top_score, top_confidence, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          randomUUID(), gapKey, args.tool, project, args.user,
          args.resultCount, args.topScore, args.topConfidence, Date.now(),
        ]
      );
    }

    await this.pruneGaps(project, args.user);
  }

  private async pruneGaps(project: string, user: string): Promise<void> {
    const maxAge = CONFIG.gaps.pruneAfterDays * 86400000;
    const cutoff = Date.now() - maxAge;

    // Prune by age (unresolved only)
    await this.pool.query(
      "DELETE FROM evidence_gaps WHERE resolved_at IS NULL AND occurred_at < $1 AND user_scope = $2",
      [cutoff, user]
    );

    // Prune by count
    await this.pool.query(
      `DELETE FROM evidence_gaps WHERE id IN (
        SELECT id FROM evidence_gaps
        WHERE project = $1 AND user_scope = $2 AND resolved_at IS NULL
        ORDER BY occurred_at DESC
        OFFSET $3
      )`,
      [project, user, CONFIG.gaps.maxPerProject]
    );
  }

  async resolveGaps(entry: KnowledgeEntry): Promise<number> {
    const entryTokens = stemmedWords(`${entry.summary} ${entry.tags.join(" ")}`);
    const project = entry.project ?? "";
    const user = entry.user ?? "default";

    const { rows: openGaps } = await this.pool.query<{ id: string; query: string }>(
      `SELECT id, query FROM evidence_gaps
       WHERE (project = $1 OR project = '') AND user_scope = $2 AND resolved_at IS NULL`,
      [project, user]
    );

    let resolved = 0;
    for (const gap of openGaps) {
      const gapTokens = stemmedWords(gap.query);
      if (jaccardSimilarity(entryTokens, gapTokens) >= CONFIG.gaps.resolutionThreshold) {
        await this.pool.query(
          "UPDATE evidence_gaps SET resolved_at = $1, resolution_id = $2 WHERE id = $3",
          [Date.now(), entry.id, gap.id]
        );
        resolved++;
      }
    }
    return resolved;
  }

  async listGaps(args: {
    project?: string;
    user?: string;
    status?: "open" | "resolved" | "all";
    minOccurrences?: number;
    limit?: number;
  }): Promise<EvidenceGap[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (args.project) {
      conditions.push(`project = $${paramIdx}`);
      params.push(args.project);
      paramIdx++;
    }

    if (args.user) {
      conditions.push(`user_scope = $${paramIdx}`);
      params.push(args.user);
      paramIdx++;
    }

    const status = args.status ?? "open";
    if (status === "open") {
      conditions.push("resolved_at IS NULL");
    } else if (status === "resolved") {
      conditions.push("resolved_at IS NOT NULL");
    }

    if (args.minOccurrences && args.minOccurrences > 1) {
      conditions.push(`occurrence_count >= $${paramIdx}`);
      params.push(args.minOccurrences);
      paramIdx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = args.limit ?? 50;

    params.push(limit);

    // nosemgrep: sql-injection-template-literal -- where from code-controlled conditions
    const { rows } = await this.pool.query<PgGapRow>(
      `SELECT * FROM evidence_gaps ${where}
       ORDER BY occurred_at DESC
       LIMIT $${paramIdx}`,
      params
    );

    return rows.map(rowToGap);
  }

  async getGapOccurrences(query: string, project: string, user: string): Promise<number> {
    const gapKey = normalizeGapKey(query);
    const { rows } = await this.pool.query<{ occurrence_count: number }>(
      `SELECT occurrence_count FROM evidence_gaps
       WHERE query = $1 AND project = $2 AND user_scope = $3 AND resolved_at IS NULL`,
      [gapKey, project, user]
    );
    return rows.length > 0 ? rows[0].occurrence_count : 0;
  }

  async getGapSummary(project?: string): Promise<{
    openCount: number;
    resolvedCount: number;
    avgTimeToResolution: number;
    mostPersistentGap: EvidenceGap | null;
  }> {
    const projectCondition = project ? " AND project = $1" : "";
    const projectParams: unknown[] = project ? [project] : [];
    const pIdx = project ? 1 : 0;

    const { rows: openRows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM evidence_gaps WHERE resolved_at IS NULL${projectCondition}`,
      projectParams
    );

    const { rows: resolvedRows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM evidence_gaps WHERE resolved_at IS NOT NULL${projectCondition}`,
      projectParams
    );

    const { rows: avgRows } = await this.pool.query<{ avg_time: string | null }>(
      `SELECT AVG(resolved_at - occurred_at) as avg_time FROM evidence_gaps WHERE resolved_at IS NOT NULL${projectCondition}`,
      projectParams
    );

    const { rows: persistentRows } = await this.pool.query<PgGapRow>(
      `SELECT * FROM evidence_gaps WHERE resolved_at IS NULL${projectCondition}
       ORDER BY occurrence_count DESC LIMIT 1`,
      projectParams
    );

    return {
      openCount: Number(openRows[0].count),
      resolvedCount: Number(resolvedRows[0].count),
      avgTimeToResolution: avgRows[0]?.avg_time ? Number(avgRows[0].avg_time) : 0,
      mostPersistentGap: persistentRows.length > 0 ? rowToGap(persistentRows[0]) : null,
    };
  }

  async dismissGap(gapId: string): Promise<void> {
    await this.pool.query(
      "UPDATE evidence_gaps SET resolved_at = $1, resolution_id = 'dismissed' WHERE id = $2",
      [Date.now(), gapId]
    );
  }
}
