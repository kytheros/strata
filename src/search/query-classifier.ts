/**
 * Lightweight query classifiers for category-aware search ranking.
 *
 * These classifiers detect query intent (counting, temporal, current-state)
 * so the search engine can skip or adjust ranking strategies that hurt
 * specific question types. Validated via LongMemEval benchmark:
 * - Reranker hurts counting questions by -6pp
 * - Reranker hurts temporal reasoning by -20pp
 * - Current-state queries benefit from recency boosting
 */

/** Detect discrete counting intent (excludes duration/sum questions) */
export function isCountingQuestion(q: string): boolean {
  if (/how (?:many|long|much)\s+(?:days?|weeks?|hours?|months?|years?|time|minutes?)/i.test(q)) return false;
  return /how many|how often|list all|total/i.test(q);
}

/** Detect duration/sum intent */
export function isDurationQuestion(q: string): boolean {
  return /how (?:many|long|much)\s+(?:days?|weeks?|hours?|months?|years?|time|minutes?)/i.test(q);
}

/** Detect temporal reasoning queries */
export function isTemporalQuestion(q: string): boolean {
  return /when did|what date|what day|what year|what month|how long ago|before or after|which came first|what time/i.test(q);
}

/** Detect "current state" queries for knowledge-update recency boosting */
export function isCurrentStateQuery(q: string): boolean {
  return /currently|current|still|now|latest|most recent|at this point|these days/i.test(q);
}
