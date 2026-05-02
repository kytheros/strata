/**
 * recall-qdp-community — Query-Driven Pruning for the Community surface.
 *
 * Mirror of `src/transports/recall-qdp.ts` (NPC surface). Three rules applied
 * in order to a fused Community candidate list:
 *   1. Near-duplicate dedupe (character-trigram Jaccard ≥ threshold)
 *   2. Filler filter (short, interrogative, exactly ['dialogue'] tags)
 *   3. Query-coverage floor (zero overlap with content-words ≥ minTokenLen)
 *
 * No LLM. Pure function. No internal state (D2).
 *
 * Differences from NPC version:
 * - Input/output type is FusedResult (Community) instead of FusedCandidate (NPC)
 * - Config defaults come from `CONFIG.recall.communityQdp` instead of
 *   `CONFIG.recall.qdp`
 * - Each rule is independently disable-able via `CommunityQdpOpts`
 *
 * Spec: 2026-05-01-tirqdp-community-port-plan.md §TIRQDP-1.5
 * Ticket: TIRQDP-1.5
 */

import { CONFIG } from "../config.js";
import type { FusedResult } from "./recall-fusion-community.js";

// Re-export QdpConfig so callers don't need to import from recall-qdp.ts
export interface QdpConfig {
  dedupeJaccard: number;
  fillerMaxLen: number;
  minTokenLen: number;
}

/**
 * Per-call opts that allow individual rules to be skipped. Useful for unit
 * tests that want to exercise a single rule in isolation, and for callers
 * that have already applied one of the rules upstream.
 *
 * Defaults: all rules enabled (all flags false / undefined).
 */
export interface CommunityQdpOpts {
  /** When true, the near-duplicate dedupe step is skipped entirely. */
  skipDedupe?: boolean;
  /** When true, the filler filter step is skipped entirely. */
  skipFiller?: boolean;
  /** When true, the query-coverage floor step is skipped entirely. */
  skipCoverage?: boolean;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "has", "had",
  "are", "were", "was", "you", "your", "they", "their", "them", "what", "when",
  "where", "which", "who", "whose", "why", "how", "but", "not", "all", "any",
  "some", "into", "than", "then", "there", "here", "about", "would", "could",
  "should", "will", "shall", "may", "might", "been", "being",
]);

/**
 * Apply Phase-0 rules-only QDP to Community fused results. Defaults to
 * `CONFIG.recall.communityQdp` when no `qdpConfig` is passed — production
 * callers don't need to thread config; tests and AutoResearch loops can
 * override per call.
 *
 * @param items     Fused Community candidates (output of fuseCommunityLanes).
 * @param query     The original search query string.
 * @param qdpConfig Threshold overrides. Defaults to CONFIG.recall.communityQdp.
 * @param opts      Per-call rule skip flags. All rules enabled by default.
 * @returns         Pruned list in the same order as the input (survivors only).
 */
export function recallQdpCommunity(
  items: FusedResult[],
  query: string,
  qdpConfig?: Partial<QdpConfig>,
  opts?: CommunityQdpOpts
): FusedResult[] {
  if (items.length === 0) return items;
  const cfg: QdpConfig = {
    dedupeJaccard: qdpConfig?.dedupeJaccard ?? CONFIG.recall.communityQdp.dedupeJaccard,
    fillerMaxLen:  qdpConfig?.fillerMaxLen  ?? CONFIG.recall.communityQdp.fillerMaxLen,
    minTokenLen:   qdpConfig?.minTokenLen   ?? CONFIG.recall.communityQdp.minTokenLen,
  };

  // 1. Dedupe — drop later items that are near-duplicates of earlier ones.
  let result: FusedResult[] = items;
  if (!opts?.skipDedupe) {
    const dedupeKept: FusedResult[] = [];
    for (const candidate of result) {
      const isDup = dedupeKept.some(kept =>
        trigramJaccard(kept.content, candidate.content) >= cfg.dedupeJaccard
      );
      if (!isDup) dedupeKept.push(candidate);
    }
    result = dedupeKept;
  }

  // 2. Filler filter — drop short, interrogative, dialogue-only items.
  if (!opts?.skipFiller) {
    result = result.filter(c => !isFiller(c, cfg.fillerMaxLen));
  }

  // 3. Query-coverage floor — drop items with zero token overlap.
  if (!opts?.skipCoverage) {
    const queryTokens = tokenize(query, cfg.minTokenLen);
    if (queryTokens.length > 0) {
      result = result.filter(c => hasCoverage(c.content, queryTokens));
    }
  }

  return result;
}

// ── Internal helpers (byte-identical logic to recall-qdp.ts) ─────────────────

function trigramJaccard(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function trigrams(s: string): Set<string> {
  const norm = s.toLowerCase();
  const set = new Set<string>();
  for (let i = 0; i + 3 <= norm.length; i++) set.add(norm.slice(i, i + 3));
  return set;
}

function isFiller(c: FusedResult, maxLen: number): boolean {
  const trimmed = c.content.trimEnd();
  const shortEnough = trimmed.length < maxLen;
  const interrogative = trimmed.endsWith("?");
  const dialogueOnly = c.tags.length === 1 && c.tags[0] === "dialogue";
  return shortEnough && interrogative && dialogueOnly;
}

function tokenize(s: string, minLen: number): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= minLen && !STOPWORDS.has(t));
}

function hasCoverage(content: string, queryTokens: string[]): boolean {
  const lower = content.toLowerCase();
  return queryTokens.some(t => lower.includes(t));
}
