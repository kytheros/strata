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
