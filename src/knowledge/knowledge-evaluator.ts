/**
 * Knowledge Evaluator
 * Gatekeeper: evaluates extracted knowledge entries before acceptance.
 *
 * Criteria: actionability, specificity, relevance.
 * Target: < 50ms per evaluation.
 *
 * Ported from Kytheros learning-evaluator.ts, simplified (no embedding dependency).
 */

export interface EvaluationResult {
  outcome: "accepted" | "rejected" | "merged";
  reason: string;
  mergedIntoId?: string;
}

// ============================================================================
// Actionability
// ============================================================================

const ACTION_PATTERNS = [
  /\b(use|avoid|prefer|always|never|must|should|ensure|set|configure|enable|disable|add|remove|check|verify|implement|call|pass|include|exclude|specify|require)\b/i,
  /\bwhen\b.*\bthen\b/i,
  /\bif\b.*\b(then|use|set|avoid)\b/i,
  /\binstead of\b/i,
  /\brather than\b/i,
  /\b(rate.?limit|timeout|retry|backoff|threshold|maximum|minimum)\b/i,
  /\b(endpoint|url|header|parameter|flag|option|argument)\b/i,
  /\b(error|exception|failure|crash|bug)\b.*\b(fix|resolve|workaround|handle)\b/i,
];

function isActionable(content: string): boolean {
  return ACTION_PATTERNS.some((pattern) => pattern.test(content));
}

// ============================================================================
// Specificity
// ============================================================================

const SPECIFICITY_PATTERNS = [
  /\d+/, // Contains numbers
  /v\d+(\.\d+)*/i, // Version numbers
  /\b(http|https|ftp):\/\//i, // URLs/endpoints
  /\b\d{3}\b/, // HTTP status codes or error codes
  /\b(api|endpoint|url|path|route)\b/i, // API references
  /\b[A-Z_]{2,}[_-][A-Z_]{2,}\b/, // Constants (e.g., MAX_RETRIES)
  /`[^`]+`/, // Backtick-quoted specifics
  /\b(ms|seconds?|minutes?|hours?|req\/s|mb|gb|kb)\b/i, // Units
  /\b(port|header|token|key|flag|param)\b/i, // Technical terms
];

function isSpecific(content: string): boolean {
  let matchCount = 0;
  for (const pattern of SPECIFICITY_PATTERNS) {
    if (pattern.test(content)) matchCount++;
  }
  // Require at least 2 specificity signals
  return matchCount >= 2;
}

// ============================================================================
// Relevance
// ============================================================================

const IRRELEVANT_PATTERNS = [
  /^(the weather|today is|i think|in my opinion|personally)/i,
  /\b(politics|sports|entertainment|gossip|celebrity)\b/i,
  /\b(joke|funny|humor|lol|haha)\b/i,
];

function isRelevant(content: string): boolean {
  return !IRRELEVANT_PATTERNS.some((pattern) => pattern.test(content));
}

// ============================================================================
// Summary sanitation + validation (title-shape gate)
// ============================================================================

export interface SummaryValidation {
  ok: boolean;
  /** The sanitized summary to persist when ok. */
  repaired: string;
  reason?: string;
}

// ESC-prefixed ANSI sequences plus bare SGR-like tokens ("[32m") — the
// chunking pipeline sometimes strips the ESC byte but leaves the token.
const ANSI_TOKENS = /\[[0-9;]*[A-Za-z]|\[\d{1,3}(?:;\d{1,3})*m/g;

// Characters a real title can open with: letters, digits, backtick-quoted
// code, or a quotation.
const VALID_START = /^[A-Za-z0-9`"']/;

/**
 * Sanitize a knowledge summary and decide whether it is a real title.
 *
 * Repairs (always applied): ANSI stripping, whitespace collapsing,
 * trimming leading punctuation noise. Rejections (the 2026-06-11 audit's
 * fragment classes): too short after repair, mostly non-letters (code
 * shrapnel, test-runner counters), markdown-table debris, and
 * punctuation-start fragments whose remainder is too short to stand
 * alone as a title.
 */
export function sanitizeAndValidateSummary(raw: string): SummaryValidation {
  const stripped = raw.replace(ANSI_TOKENS, "").replace(/\s+/g, " ").trim();
  const startedMalformed = !VALID_START.test(stripped);
  const repaired = stripped.replace(/^[^A-Za-z0-9`"']+/, "").trim();

  if (repaired.length < 6) {
    return { ok: false, repaired, reason: "too short after repair" };
  }

  const nonSpace = repaired.replace(/\s+/g, "");
  const letters = (repaired.match(/[A-Za-z]/g) ?? []).length;
  if (nonSpace.length > 0 && letters / nonSpace.length < 0.4) {
    return { ok: false, repaired, reason: "mostly non-letters (code/output shrapnel)" };
  }

  if ((repaired.match(/\|/g) ?? []).length >= 3) {
    return { ok: false, repaired, reason: "markdown-table debris" };
  }

  if (startedMalformed && repaired.length < 30) {
    return { ok: false, repaired, reason: "punctuation-start fragment" };
  }

  return { ok: true, repaired };
}

// ============================================================================
// Evaluator
// ============================================================================

export class KnowledgeEvaluator {
  /**
   * Evaluate a candidate knowledge entry.
   * Returns accepted/rejected with reason.
   *
   * @param content - The text to evaluate (summary + details)
   * @param entryType - Optional knowledge type. Personal types (fact, preference, episodic)
   *   bypass actionability/specificity checks since they have different quality signals.
   */
  evaluate(content: string, entryType?: string): EvaluationResult {
    // Personal knowledge types are accepted unconditionally —
    // they have different quality signals than coding patterns
    if (entryType === "fact" || entryType === "preference" || entryType === "episodic") {
      return {
        outcome: "accepted",
        reason: "Personal knowledge type",
      };
    }

    if (!isActionable(content)) {
      return {
        outcome: "rejected",
        reason: "Not actionable — lacks concrete, usable patterns",
      };
    }

    if (!isSpecific(content)) {
      return {
        outcome: "rejected",
        reason:
          "Not specific — lacks concrete details (versions, endpoints, thresholds, error codes)",
      };
    }

    if (!isRelevant(content)) {
      return {
        outcome: "rejected",
        reason: "Not relevant to operational domain",
      };
    }

    return {
      outcome: "accepted",
      reason: "Passes actionability, specificity, and relevance checks",
    };
  }
}
