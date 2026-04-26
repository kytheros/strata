/**
 * recall-qdp — Query-Driven Pruning (rules-only, Phase 0).
 *
 * Three rules applied in order to a fused candidate list:
 *   1. Near-duplicate dedupe (character-trigram Jaccard ≥ threshold)
 *   2. Filler filter (short, interrogative, exactly ['dialogue'] tags)
 *   3. Query-coverage floor (zero overlap with content-words ≥ minTokenLen)
 *
 * No LLM. Pure function. Phase 1 (LLM-QDP) is gated on frozen-eval results.
 *
 * Spec: 2026-04-26-npc-recall-tir-qdp-design.md §Read path.
 */

import { CONFIG } from "../config.js";
import type { FusedCandidate } from "./recall-fusion.js";

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "has", "had",
  "are", "were", "was", "you", "your", "they", "their", "them", "what", "when",
  "where", "which", "who", "whose", "why", "how", "but", "not", "all", "any",
  "some", "into", "than", "then", "there", "here", "about", "would", "could",
  "should", "will", "shall", "may", "might", "been", "being",
]);

export interface QdpConfig {
  dedupeJaccard: number;
  fillerMaxLen: number;
  minTokenLen: number;
}

/**
 * Apply Phase-0 rules-only QDP. Defaults to `CONFIG.recall.qdp` when no
 * `qdpConfig` is passed — production callers don't need to thread config,
 * tests and AutoResearch loops can override per call.
 */
export function recallQdp(
  items: FusedCandidate[],
  query: string,
  qdpConfig?: QdpConfig
): FusedCandidate[] {
  if (items.length === 0) return items;
  const cfg = qdpConfig ?? CONFIG.recall.qdp;

  // 1. Dedupe — drop later items that are near-duplicates of earlier ones.
  const dedupeKept: FusedCandidate[] = [];
  for (const candidate of items) {
    const isDup = dedupeKept.some(kept =>
      trigramJaccard(kept.content, candidate.content) >= cfg.dedupeJaccard
    );
    if (!isDup) dedupeKept.push(candidate);
  }

  // 2. Filler filter — drop short, interrogative, dialogue-only items.
  const fillerFiltered = dedupeKept.filter(c => !isFiller(c, cfg.fillerMaxLen));

  // 3. Query-coverage floor — drop items with zero token overlap.
  const queryTokens = tokenize(query, cfg.minTokenLen);
  if (queryTokens.length === 0) return fillerFiltered;
  return fillerFiltered.filter(c => hasCoverage(c.content, queryTokens));
}

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

function isFiller(c: FusedCandidate, maxLen: number): boolean {
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
