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

/**
 * Two-signal temporal-current-state classifier (spec 2026-05-18-temporal-retrieval-intervention).
 *
 * Gates the turn-lane recency boost. Returns true only when:
 *   (temporal-marker OR version-keyword) AND current-state-marker AND NOT historical-marker
 *
 * The historical-marker veto prevents false-positives on queries like
 * "What Node version did I see last year?" where the user wants older evidence.
 */

/** Topical markers that suggest the query is about a versioned / configurable thing. */
export function hasTemporalMarker(q: string): boolean {
  return /\bversion\b|\bnode\b|\busing\b|\binstalled\b|\brunning\b|\bsetup\b|\bbranch\b|\bmodel\b|\bprovider\b/i.test(q);
}

/** Markers that suggest the user wants the CURRENT state, not historical. */
export function hasCurrentStateMarker(q: string): boolean {
  return /\bnow\b|\bcurrently\b|\bcurrent\b|\btoday\b|\bright now\b|\bam i on\b|\bis the user on\b|\bdo i have\b|\bwhat's my\b|\bwhat is the user on\b/i.test(q);
}

/** Markers that explicitly anchor the query to a past state — veto signal. */
export function hasHistoricalMarker(q: string): boolean {
  return /\blast (?:year|month|week|quarter)\b|\bpreviously\b|\boriginally\b|\bused to\b|\bback when\b|\bbefore the\b|\bago\b|\bprior to\b/i.test(q);
}

/**
 * Existential question pattern: "Is X a/an/the Y" at the start of the query.
 * Grammatically present-tense; treated as a sufficient signal for current-state
 * intent. Lifts queries that lack explicit temporal markers but are clearly
 * asking about current classification (e.g., "Is semantic search a Pro feature?").
 *
 * Spec: 2026-05-23-existential-question-classifier-design.md
 */
export function isExistentialQuestion(q: string): boolean {
  return /^\s*Is\s+.+?\s+(?:a|an|the)\s+\S+/i.test(q);
}

/**
 * Composite aggregation-intent trigger for counting-aware context assembly
 * (#37 C1, v2). Deterministic and label-free: discrete counting OR duration/sum.
 * Deliberately excludes bare "/how much/" — that pattern fires on comparative
 * and superlative queries ("who spent the most") that are NOT aggregation questions
 * and regress when given counting guidance. "How much total/money/cost" is
 * covered by isCountingQuestion's /total/ clause.
 */
export function isAggregationQuery(q: string): boolean {
  return isCountingQuestion(q) || isDurationQuestion(q);
}

/**
 * Composite classifier. Returns true when EITHER:
 *   isExistentialQuestion(q) (present-tense "Is X a/an/the Y" pattern), OR
 *   (hasTemporalMarker(q) OR isCurrentStateQuery(q)) AND hasCurrentStateMarker(q)
 *
 * In all cases, returns false if hasHistoricalMarker(q) (the veto wins).
 *
 * `isCurrentStateQuery` is OR'd in so existing "currently/still/latest" phrasings
 * still qualify even without a topical marker. `isExistentialQuestion` short-circuits
 * to true on grammatically present-tense yes/no questions about classification
 * (spec 2026-05-23-existential-question-classifier).
 */
export function isTemporalCurrentStateQuestion(q: string): boolean {
  if (hasHistoricalMarker(q)) return false;
  if (isExistentialQuestion(q)) return true;
  if (!hasCurrentStateMarker(q)) return false;
  return hasTemporalMarker(q) || isCurrentStateQuery(q);
}
