/**
 * Context Budget Manager
 * Heuristic token counting with 3-tier threshold callbacks.
 *
 * Ported from Kytheros context-budget.ts, simplified for Strata.
 */

// ============================================================================
// Types
// ============================================================================

export interface BudgetStatus {
  total: number;
  used: number;
  available: number;
  utilizationPercent: number;
  warningThreshold: number;
  compactionThreshold: number;
  criticalThreshold: number;
}

export interface ContextBudgetCallbacks {
  onWarning?: (status: BudgetStatus) => void;
  onCompaction?: (status: BudgetStatus) => void;
  onCritical?: (status: BudgetStatus) => void;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONTEXT_WINDOW = 200000;
const FIXED_OVERHEAD = 10000; // system prompt + tool defs
const MIN_OUTPUT_RESERVATION = 4096;
const EC_MEMORY_FRACTION = 0.4;

const WARNING_THRESHOLD = 0.7;
const COMPACTION_THRESHOLD = 0.8;
const CRITICAL_THRESHOLD = 0.95;

const SAFETY_BUFFER_PERCENT = 0.05;
const SAFETY_BUFFER_MAX = 1000;

// CJK Unicode ranges for heuristic token counting
const CJK_REGEX =
  /[\u4e00-\u9fff\u3400-\u4dbf\u2e80-\u2eff\u3000-\u303f\uff00-\uffef\uac00-\ud7af]/g;

// ============================================================================
// ContextBudgetManager
// ============================================================================

export class ContextBudgetManager {
  private callbacks: ContextBudgetCallbacks;
  private usedTokens = 0;
  private warningFired = false;
  private compactionFired = false;
  private criticalFired = false;
  private contextWindow: number;

  constructor(
    callbacks: ContextBudgetCallbacks = {},
    contextWindow = DEFAULT_CONTEXT_WINDOW
  ) {
    this.callbacks = callbacks;
    this.contextWindow = contextWindow;
  }

  // ==========================================================================
  // Token Counting
  // ==========================================================================

  /**
   * Count tokens using heuristic: ASCII ~4 chars/token, CJK ~1.3 tokens/char.
   */
  countTokens(text: string): number {
    const cjkMatches = text.match(CJK_REGEX);
    const cjkCount = cjkMatches ? cjkMatches.length : 0;
    const asciiCount = text.length - cjkCount;

    const rawTokens = Math.ceil(asciiCount / 4) + Math.ceil(cjkCount * 1.3);
    return this.applySafetyBuffer(rawTokens);
  }

  private applySafetyBuffer(tokens: number): number {
    const buffer = Math.min(
      Math.ceil(tokens * SAFETY_BUFFER_PERCENT),
      SAFETY_BUFFER_MAX
    );
    return tokens + buffer;
  }

  // ==========================================================================
  // Budget Computation
  // ==========================================================================

  /**
   * Compute the conversation budget allocation.
   */
  getConversationBudget(): number {
    const availableForContent = Math.max(
      0,
      this.contextWindow - FIXED_OVERHEAD - MIN_OUTPUT_RESERVATION
    );
    const ecClaim = Math.floor(availableForContent * EC_MEMORY_FRACTION);
    return Math.max(0, availableForContent - ecClaim);
  }

  // ==========================================================================
  // Budget Monitoring
  // ==========================================================================

  recordTokenUsage(tokens: number): void {
    this.usedTokens = tokens;
    this.checkThresholds();
  }

  getBudgetStatus(): BudgetStatus {
    const total = this.getConversationBudget();
    const used = this.usedTokens;
    const available = Math.max(0, total - used);

    return {
      total,
      used,
      available,
      utilizationPercent: total > 0 ? Math.round((used / total) * 100) : 0,
      warningThreshold: WARNING_THRESHOLD,
      compactionThreshold: COMPACTION_THRESHOLD,
      criticalThreshold: CRITICAL_THRESHOLD,
    };
  }

  isBudgetExceeded(): boolean {
    return this.usedTokens > this.getConversationBudget();
  }

  /**
   * Reset threshold flags (e.g., after compaction or model switch).
   */
  reset(): void {
    this.warningFired = false;
    this.compactionFired = false;
    this.criticalFired = false;
  }

  // ==========================================================================
  // Private: Threshold Checking
  // ==========================================================================

  private checkThresholds(): void {
    const total = this.getConversationBudget();
    if (total === 0) return;

    const utilization = this.usedTokens / total;

    // Critical (95%) — fire first to ensure it's not missed
    if (utilization >= CRITICAL_THRESHOLD && !this.criticalFired) {
      this.criticalFired = true;
      this.callbacks.onCritical?.(this.getBudgetStatus());
    }

    // Compaction (80%)
    if (utilization >= COMPACTION_THRESHOLD && !this.compactionFired) {
      this.compactionFired = true;
      this.callbacks.onCompaction?.(this.getBudgetStatus());
    }

    // Warning (70%)
    if (utilization >= WARNING_THRESHOLD && !this.warningFired) {
      this.warningFired = true;
      this.callbacks.onWarning?.(this.getBudgetStatus());
    }
  }
}
