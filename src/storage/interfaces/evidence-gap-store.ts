/**
 * IEvidenceGapStore interface: async-first contract for evidence gap persistence.
 *
 * Extracted from evidence-gaps.ts to allow Postgres (and future) adapters
 * without direct db.prepare() calls.
 */

import type { EvidenceGap } from "../../search/evidence-gaps.js";
import type { KnowledgeEntry } from "../../knowledge/knowledge-store.js";

export interface IEvidenceGapStore {
  /** Record a gap when search returns empty or low-confidence results. */
  recordGap(args: {
    query: string;
    tool: string;
    project?: string;
    user: string;
    resultCount: number;
    topScore: number | null;
    topConfidence: number | null;
  }): Promise<void>;

  /** Check if any open gaps are resolved by a newly stored knowledge entry. */
  resolveGaps(entry: KnowledgeEntry): Promise<number>;

  /** Query gaps with optional filters. */
  listGaps(args: {
    project?: string;
    user?: string;
    status?: "open" | "resolved" | "all";
    minOccurrences?: number;
    limit?: number;
  }): Promise<EvidenceGap[]>;

  /** Look up occurrence count for a matching open gap. */
  getGapOccurrences(query: string, project: string, user: string): Promise<number>;

  /** Gap summary statistics for dashboard. */
  getGapSummary(project?: string): Promise<{
    openCount: number;
    resolvedCount: number;
    avgTimeToResolution: number;
    mostPersistentGap: EvidenceGap | null;
  }>;

  /** Dismiss a gap (mark as irrelevant by user). */
  dismissGap(gapId: string): Promise<void>;
}
