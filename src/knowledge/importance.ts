/**
 * Importance scoring for cognitive retrieval.
 *
 * Computes a composite importance score in [0, 1] from four heuristic signals:
 *   1. Knowledge type (decision > learning > error_fix > ... > episodic)
 *   2. Language markers (regex-detected phrases that predict importance)
 *   3. Cross-session frequency (occurrences + project spread)
 *   4. Explicit storage (user-intentional store_memory calls)
 *
 * The composite formula:
 *   importance = w_type * type_score + w_lang * language_score
 *              + w_freq * frequency_score + w_expl * explicit_score
 *
 * Importance is computed once at write/index time and stored as a column.
 * The result-ranker applies it as a multiplicative boost:
 *   score *= (1.0 + importance * CONFIG.importance.boostMax)
 *
 * Setting boostMax = 0 disables the feature entirely (backward compatible).
 */

import { CONFIG } from "../config.js";
import type { KnowledgeType } from "./knowledge-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportanceInput {
  text: string;
  role?: "user" | "assistant" | "mixed";
  sessionId: string;
  /** Present for knowledge entries; absent for raw document chunks. */
  knowledgeType?: KnowledgeType;
  /** Cross-session occurrence count (from learning synthesizer). */
  occurrences?: number;
  /** Number of distinct projects this entry appears in. */
  projectCount?: number;
  /** Pre-computed importance, if already available. */
  importance?: number;
}

// ---------------------------------------------------------------------------
// Signal 1: Type importance map
// ---------------------------------------------------------------------------

export const TYPE_IMPORTANCE: Record<KnowledgeType, number> = {
  decision: 1.0,
  learning: 0.9,
  error_fix: 0.85,
  pattern: 0.8,
  procedure: 0.75,
  preference: 0.7,
  fact: 0.6,
  solution: 0.5,
  episodic: 0.3,
};

// ---------------------------------------------------------------------------
// Signal 2: Language markers
// ---------------------------------------------------------------------------

interface LanguageMarker {
  pattern: RegExp;
  score: number;
}

/**
 * Regex-detectable phrases that predict importance, ordered by score
 * (highest first). Only the max-scoring match is used.
 */
export const LANGUAGE_MARKERS: LanguageMarker[] = [
  // Decision markers (1.0)
  { pattern: /\bdecided\s+to\b/i, score: 1.0 },
  { pattern: /\bgoing\s+with\b/i, score: 1.0 },
  { pattern: /\bwe\s+chose\b/i, score: 1.0 },
  { pattern: /\bswitched\s+to\b/i, score: 1.0 },
  { pattern: /\bfrom\s+now\s+on\b/i, score: 1.0 },
  // Negation of alternatives (0.9)
  { pattern: /\binstead\s+of\b/i, score: 0.9 },
  { pattern: /\brather\s+than\b/i, score: 0.9 },
  { pattern: /\bnot\s+using\b/i, score: 0.9 },
  { pattern: /\brejected\b/i, score: 0.9 },
  // Error / consequence (0.85)
  { pattern: /\bthis\s+caused\b/i, score: 0.85 },
  { pattern: /\bthis\s+broke\b/i, score: 0.85 },
  { pattern: /\bthe\s+issue\s+was\b/i, score: 0.85 },
  { pattern: /\broot\s+cause\b/i, score: 0.85 },
  // Temporal permanence (0.8)
  { pattern: /\balways\b/i, score: 0.8 },
  { pattern: /\bnever\b/i, score: 0.8 },
  { pattern: /\bgoing\s+forward\b/i, score: 0.8 },
  { pattern: /\bpermanently\b/i, score: 0.8 },
  // Preference signals (0.75)
  { pattern: /\bI\s+prefer\b/i, score: 0.75 },
  { pattern: /\bplease\s+always\b/i, score: 0.75 },
  { pattern: /\bdon['']?t\s+ever\b/i, score: 0.75 },
  { pattern: /\bmake\s+sure\s+to\b/i, score: 0.75 },
  // Implementation (0.5)
  { pattern: /\bimplemented\b/i, score: 0.5 },
  { pattern: /\bdeployed\b/i, score: 0.5 },
  { pattern: /\bshipped\b/i, score: 0.5 },
  { pattern: /\breleased\b/i, score: 0.5 },
  // Status / filler (0.1)
  { pattern: /\bworking\s+on\b/i, score: 0.1 },
  { pattern: /\blooking\s+at\b/i, score: 0.1 },
  { pattern: /\blet\s+me\s+check\b/i, score: 0.1 },
];

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Compute the composite importance score for a knowledge entry or document chunk.
 *
 * If `input.importance` is already set (pre-computed), returns it directly.
 *
 * @returns A score in [0, 1].
 */
export function computeImportance(input: ImportanceInput): number {
  // Short-circuit if pre-computed
  if (input.importance != null) {
    return input.importance;
  }

  // Signal 1: Type score
  const typeScore = input.knowledgeType
    ? TYPE_IMPORTANCE[input.knowledgeType]
    : inferTypeFromRole(input.role, input.text);

  // Signal 2: Language markers
  const langScore = computeLanguageScore(input.text);

  // Signal 3: Cross-session frequency
  const freqScore =
    input.occurrences && input.projectCount
      ? Math.min(
          1.0,
          (input.occurrences / 5) * 0.6 + (input.projectCount / 3) * 0.4,
        )
      : 0.0;

  // Signal 4: Explicit storage
  const explScore = input.sessionId === "explicit-memory" ? 1.0 : 0.0;

  // Composite
  return (
    CONFIG.importance.typeWeight * typeScore +
    CONFIG.importance.languageWeight * langScore +
    CONFIG.importance.frequencyWeight * freqScore +
    CONFIG.importance.explicitWeight * explScore
  );
}

/**
 * Infer a type-equivalent importance score from the document chunk's role
 * and text content (used when no explicit KnowledgeType is available).
 *
 * - user role with decision language: 0.7
 * - assistant role with code blocks: 0.6
 * - mixed role: 0.4
 * - Default: 0.3
 */
export function inferTypeFromRole(
  role: string | undefined,
  text: string,
): number {
  if (role === "user") {
    // Check for decision language
    const hasDecisionLanguage = LANGUAGE_MARKERS.some(
      (m) => m.score >= 0.9 && m.pattern.test(text),
    );
    return hasDecisionLanguage ? 0.7 : 0.4;
  }
  if (role === "assistant") {
    // Check for code blocks
    const hasCodeBlocks = /```[\s\S]*?```/.test(text);
    return hasCodeBlocks ? 0.6 : 0.35;
  }
  if (role === "mixed") {
    return 0.4;
  }
  // No role — default
  return 0.3;
}

/**
 * Compute the language marker score for a text.
 * Returns the max score of all matching patterns, or 0.3 (neutral) if none match.
 */
export function computeLanguageScore(text: string): number {
  let maxScore = -1;

  for (const marker of LANGUAGE_MARKERS) {
    if (marker.pattern.test(text)) {
      if (marker.score > maxScore) {
        maxScore = marker.score;
      }
      // Early exit: 1.0 is the max possible
      if (maxScore >= 1.0) break;
    }
  }

  return maxScore >= 0 ? maxScore : 0.3;
}
