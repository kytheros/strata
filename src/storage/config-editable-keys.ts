/**
 * Dashboard-editable CONFIG keys — single source of truth shared by:
 *   - the Pro PUT /api/settings/config handler (allowlist validation)
 *   - the Pro Dashboard SPA ConfigEditor (catalog of editable rows)
 *
 * Each entry pins:
 *   path    — dot-path into CONFIG (matches dashboard-overrides format)
 *   type    — input type for the SPA + validation hint for the backend
 *   default — for "reset" affordance and type validation fallback
 *   locked  — true means AutoResearch-tuned; SPA requires confirm to edit
 *   min/max — optional bounds for `number` keys
 *   restart — true if the value is consumed at module-load and won't apply
 *             until the server restarts. The SPA shows a restart banner.
 */

export type EditableType = "number" | "boolean" | "string";

export interface EditableKey {
  path: string;
  type: EditableType;
  default: number | boolean | string;
  label: string;
  description: string;
  locked: boolean;
  restart: boolean;
  min?: number;
  max?: number;
  section: "search" | "indexing" | "learning" | "gaps" | "health" | "importance" | "reranker" | "session";
}

export const EDITABLE_KEYS: ReadonlyArray<EditableKey> = [
  // === SEARCH ===
  {
    path: "search.defaultLimit",
    type: "number", default: 20, min: 1, max: 200,
    label: "Default result limit",
    description: "Default number of results returned by search MCP tools when no limit is specified.",
    locked: false, restart: false, section: "search",
  },
  {
    path: "search.maxLimit",
    type: "number", default: 100, min: 1, max: 1000,
    label: "Max result limit",
    description: "Upper bound on `limit` parameter callers can request.",
    locked: false, restart: false, section: "search",
  },
  {
    path: "search.contextLines",
    type: "number", default: 3, min: 0, max: 50,
    label: "Context lines per result",
    description: "Lines of surrounding context returned with each search hit.",
    locked: false, restart: false, section: "search",
  },
  {
    path: "search.useTirQdp",
    type: "boolean", default: false,
    label: "TIR+QDP retrieval (turn-lane)",
    description: "Enable turn-level retrieval. Flip only after AutoResearch confirms no regression on your corpus.",
    locked: true, restart: false, section: "search",
  },
  {
    path: "search.rrfK",
    type: "number", default: 40, min: 1, max: 200,
    label: "RRF K constant",
    description: "Reciprocal-rank-fusion constant. AutoResearch-locked at 40 (58/58 on rrf-fusion eval).",
    locked: true, restart: false, section: "search",
  },
  {
    path: "search.rrfDualListBonus",
    type: "number", default: 0.3, min: 0, max: 1,
    label: "RRF dual-list bonus",
    description: "Score bonus when a doc appears in both ranked lists. AutoResearch-tuned.",
    locked: true, restart: false, section: "search",
  },
  {
    path: "search.vectorSimBonus",
    type: "number", default: 0.005, min: 0, max: 1,
    label: "Vector similarity bonus",
    description: "Additive cosine-similarity tiebreaker. AutoResearch-tuned at 0.005.",
    locked: true, restart: false, section: "search",
  },

  // === INDEXING ===
  {
    path: "indexing.chunkSize",
    type: "number", default: 1600, min: 100, max: 8000,
    label: "Chunk size (tokens)",
    description: "Tokens per session chunk. AutoResearch-locked at 1600 (25/25 on chunking eval).",
    locked: true, restart: true, section: "indexing",
  },
  {
    path: "indexing.chunkOverlap",
    type: "number", default: 50, min: 0, max: 500,
    label: "Chunk overlap (tokens)",
    description: "Token overlap between adjacent chunks. AutoResearch-tuned.",
    locked: true, restart: true, section: "indexing",
  },
  {
    path: "indexing.maxChunksPerSession",
    type: "number", default: 500, min: 10, max: 5000,
    label: "Max chunks per session",
    description: "Cap on chunks produced per session. Larger sessions get truncated.",
    locked: false, restart: false, section: "indexing",
  },
  {
    path: "indexing.maxPdfPages",
    type: "number", default: 100, min: 1, max: 1000,
    label: "Max PDF pages",
    description: "PDFs longer than this get truncated on the text-only path.",
    locked: false, restart: false, section: "indexing",
  },

  // === LEARNING ===
  {
    path: "learning.maxLearningsPerProject",
    type: "number", default: 10, min: 1, max: 100,
    label: "Max learnings / project",
    description: "Cap on synthesized learnings exposed per project.",
    locked: false, restart: false, section: "learning",
  },
  {
    path: "learning.maxLearningLength",
    type: "number", default: 120, min: 40, max: 500,
    label: "Max learning length (chars)",
    description: "Trim learning summaries to this character count.",
    locked: false, restart: false, section: "learning",
  },
  {
    path: "learning.memoryLineBudget",
    type: "number", default: 200, min: 50, max: 1000,
    label: "MEMORY.md line budget",
    description: "Max lines in the generated MEMORY.md.",
    locked: false, restart: false, section: "learning",
  },
  {
    path: "learning.similarityThreshold",
    type: "number", default: 0.6, min: 0, max: 1,
    label: "Cluster similarity threshold",
    description: "Jaccard similarity floor for clustering. AutoResearch-tuned.",
    locked: true, restart: false, section: "learning",
  },
  {
    path: "learning.promotionThreshold",
    type: "number", default: 10, min: 1, max: 100,
    label: "Promotion threshold",
    description: "Minimum score to promote a cluster to a learning. AutoResearch-tuned.",
    locked: true, restart: false, section: "learning",
  },

  // === IMPORTANCE ===
  {
    path: "importance.boostMax",
    type: "number", default: 1.0, min: 0, max: 5,
    label: "Importance boost max",
    description: "Maximum boost multiplier applied in search ranking. 0 disables.",
    locked: false, restart: false, section: "importance",
  },
  {
    path: "importance.typeWeight",
    type: "number", default: 0.35, min: 0, max: 1,
    label: "Type signal weight",
    description: "AutoResearch-tuned. Should sum to 1.0 with the other weights.",
    locked: true, restart: false, section: "importance",
  },
  {
    path: "importance.languageWeight",
    type: "number", default: 0.20, min: 0, max: 1,
    label: "Language signal weight",
    description: "AutoResearch-tuned.",
    locked: true, restart: false, section: "importance",
  },
  {
    path: "importance.frequencyWeight",
    type: "number", default: 0.35, min: 0, max: 1,
    label: "Frequency signal weight",
    description: "AutoResearch-tuned.",
    locked: true, restart: false, section: "importance",
  },

  // === BM25 ===
  {
    path: "bm25.k1",
    type: "number", default: 1.2, min: 0, max: 10,
    label: "BM25 k1",
    description: "AutoResearch-locked at 1.2 (58/58 on rrf-fusion eval). Changing degrades benchmarks.",
    locked: true, restart: false, section: "search",
  },
  {
    path: "bm25.b",
    type: "number", default: 0.75, min: 0, max: 1,
    label: "BM25 b",
    description: "AutoResearch-locked at 0.75.",
    locked: true, restart: false, section: "search",
  },

  // === GAPS ===
  {
    path: "gaps.enabled",
    type: "boolean", default: true,
    label: "Track evidence gaps",
    description: "Disable to stop recording zero-result searches as gaps.",
    locked: false, restart: false, section: "gaps",
  },
  {
    path: "gaps.maxPerProject",
    type: "number", default: 100, min: 10, max: 1000,
    label: "Max open gaps / project",
    description: "Oldest gaps auto-pruned past this count.",
    locked: false, restart: false, section: "gaps",
  },
  {
    path: "gaps.pruneAfterDays",
    type: "number", default: 90, min: 1, max: 365,
    label: "Auto-prune after (days)",
    description: "Unresolved gaps older than this get dropped.",
    locked: false, restart: false, section: "gaps",
  },
  {
    path: "gaps.resolutionThreshold",
    type: "number", default: 0.4, min: 0, max: 1,
    label: "Resolution similarity",
    description: "Minimum Jaccard similarity for auto-resolving a gap against a new entry.",
    locked: false, restart: false, section: "gaps",
  },

  // === HEALTH THRESHOLDS ===
  {
    path: "health.thresholds.embedding_coverage.ok",
    type: "number", default: 0.95, min: 0, max: 1,
    label: "Embedding coverage OK threshold",
    description: "Embedding coverage at or above this = ok status.",
    locked: false, restart: false, section: "health",
  },
  {
    path: "health.thresholds.embedding_coverage.warn",
    type: "number", default: 0.70, min: 0, max: 1,
    label: "Embedding coverage WARN threshold",
    description: "Below this = err status.",
    locked: false, restart: false, section: "health",
  },
  {
    path: "health.thresholds.summary_coverage.ok",
    type: "number", default: 0.50, min: 0, max: 1,
    label: "Summary coverage OK threshold",
    description: "Sessions-with-summaries ratio at or above this = ok status.",
    locked: false, restart: false, section: "health",
  },
  {
    path: "health.thresholds.summary_coverage.warn",
    type: "number", default: 0.20, min: 0, max: 1,
    label: "Summary coverage WARN threshold",
    description: "Below this = err status.",
    locked: false, restart: false, section: "health",
  },
  {
    path: "health.thresholds.extraction_success.ok",
    type: "number", default: 0.95, min: 0, max: 1,
    label: "Extraction success OK threshold",
    description: "1 - (failed sessions / total) at or above this = ok status.",
    locked: false, restart: false, section: "health",
  },
  {
    path: "health.thresholds.extraction_success.warn",
    type: "number", default: 0.80, min: 0, max: 1,
    label: "Extraction success WARN threshold",
    description: "Below this = err status.",
    locked: false, restart: false, section: "health",
  },
  {
    path: "health.thresholds.entity_quality.ok",
    type: "number", default: 0.85, min: 0, max: 1,
    label: "Entity quality OK threshold",
    description: "1 - (noise entities / total) at or above this = ok status.",
    locked: false, restart: false, section: "health",
  },
  {
    path: "health.thresholds.entity_quality.warn",
    type: "number", default: 0.60, min: 0, max: 1,
    label: "Entity quality WARN threshold",
    description: "Below this = err status.",
    locked: false, restart: false, section: "health",
  },
  {
    path: "health.thresholds.gap_close_rate.ok",
    type: "number", default: 0.50, min: 0, max: 1,
    label: "Gap close rate OK threshold",
    description: "Gaps resolved within 30d at or above this ratio = ok status.",
    locked: false, restart: false, section: "health",
  },
  {
    path: "health.thresholds.gap_close_rate.warn",
    type: "number", default: 0.20, min: 0, max: 1,
    label: "Gap close rate WARN threshold",
    description: "Below this = err status.",
    locked: false, restart: false, section: "health",
  },

  // === RERANKER ===
  {
    path: "reranker.enabled",
    type: "boolean", default: true,
    label: "Enable cross-encoder reranker",
    description: "Disable to fall back to pure DCG ranking.",
    locked: false, restart: true, section: "reranker",
  },
  {
    path: "reranker.candidateCount",
    type: "number", default: 30, min: 5, max: 200,
    label: "Reranker candidate count",
    description: "Top-N from DCG sent to the reranker.",
    locked: false, restart: false, section: "reranker",
  },
  {
    path: "reranker.alpha",
    type: "number", default: 0.7, min: 0, max: 1,
    label: "Reranker blend alpha",
    description: "final = alpha * rerank + (1-alpha) * DCG. 1.0 = pure rerank, 0.0 = pure DCG.",
    locked: false, restart: false, section: "reranker",
  },

  // === SESSION ===
  {
    path: "session.sessionTopK",
    type: "number", default: 10, min: 1, max: 100,
    label: "Session top-K",
    description: "Number of sessions returned from session-level search.",
    locked: false, restart: false, section: "session",
  },
];

export function findEditableKey(path: string): EditableKey | undefined {
  return EDITABLE_KEYS.find((k) => k.path === path);
}

/**
 * Validate a single override against its EditableKey entry.
 * Returns null if valid, or an error string if not.
 */
export function validateOverride(path: string, value: unknown): string | null {
  const key = findEditableKey(path);
  if (!key) return `unknown override path: ${path}`;
  if (value === null || value === undefined) return null; // null = reset
  if (key.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return `${path}: expected finite number, got ${typeof value}`;
    }
    if (key.min !== undefined && value < key.min) {
      return `${path}: value ${value} below min ${key.min}`;
    }
    if (key.max !== undefined && value > key.max) {
      return `${path}: value ${value} above max ${key.max}`;
    }
  } else if (key.type === "boolean") {
    if (typeof value !== "boolean") {
      return `${path}: expected boolean, got ${typeof value}`;
    }
  } else if (key.type === "string") {
    if (typeof value !== "string") {
      return `${path}: expected string, got ${typeof value}`;
    }
  }
  return null;
}
