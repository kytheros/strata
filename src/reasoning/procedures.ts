/**
 * Question-type classification and step-by-step procedures for the reasoning agent loop.
 *
 * Ported from the LongMemEval benchmark agent loop (benchmarks/longmemeval/agent-loop.ts)
 * for production use. This module is shared by both the `reason_over_query` MCP tool
 * (server-side agent loop) and the `get_search_procedure` MCP tool (client-side guidance).
 *
 * Classification reuses existing classifiers from search/query-classifier.ts and adds
 * isComparisonQuestion for superlative/ranking queries.
 */

import {
  isCountingQuestion,
  isDurationQuestion,
  isTemporalQuestion,
} from "../search/query-classifier.js";

// ---------------------------------------------------------------------------
// Question types
// ---------------------------------------------------------------------------

/** Supported question-type categories for procedure selection */
export type QuestionType =
  | "counting"
  | "duration"
  | "comparison"
  | "temporal"
  | "factual";

// ---------------------------------------------------------------------------
// Classifiers
// ---------------------------------------------------------------------------

/** Detect superlative/ranking queries (most, least, highest, lowest, etc.) */
export function isComparisonQuestion(q: string): boolean {
  return /which.*most|which.*least|most.*time|most.*often|most expensive|cheapest|highest|lowest|most money|most followers/i.test(
    q
  );
}

/**
 * Classify a question into a QuestionType for procedure selection.
 *
 * Priority order matches the benchmark's selectProcedure logic:
 *   duration -> counting -> comparison -> temporal -> factual
 */
export function classifyQuestion(question: string): QuestionType {
  if (isDurationQuestion(question)) return "duration";
  if (isCountingQuestion(question)) return "counting";
  if (isComparisonQuestion(question)) return "comparison";
  if (isTemporalQuestion(question)) return "temporal";
  return "factual";
}

// ---------------------------------------------------------------------------
// Procedures
// ---------------------------------------------------------------------------

const PROCEDURE_COUNTING = `COUNTING PROCEDURE:
This question asks you to count discrete items across multiple conversations.

Required steps:
1. Call count_sessions() first to understand the total scope.
2. Call search_events() with the topic keyword — gives structured entries, one per distinct event.
3. Call search_sessions() with 2-3 different phrasings. Same topic uses different words:
   "purchased" vs "bought" vs "ordered" vs "got" vs "picked up".
   "attended" vs "went to" vs "was at" vs "showed up for".
4. For any session that looks promising, call get_session() to read the full conversation.
5. Before counting: list ALL candidate items found across all your searches.
   Identify duplicates explicitly: the same item mentioned in 3 sessions = 1 item, not 3.
   Apply the question's exact qualifier strictly.
6. State your final count with the complete list of qualifying items as evidence.

IMPORTANT: Do not commit to a count until you have run at least 3 searches with different vocabulary.`;

const PROCEDURE_DURATION = `DURATION PROCEDURE:
This question asks you to add up time periods or amounts across conversations.

Required steps:
1. Call search_events() with the activity type to find structured time/amount entries.
2. Call search_sessions() with 2 phrasings — people describe durations differently.
3. For sessions with ambiguous numbers, call get_session() to read the exact value.
4. List every time period or amount found with its unit.
5. Check for duplicates: the same period mentioned in two sessions = count once.
6. Sum the qualifying values and state the total with units.`;

const PROCEDURE_COMPARISON = `COMPARISON PROCEDURE:
This question asks which option is most/least frequent, or ranks highest/lowest.

Required steps:
1. Call search_sessions() with the topic.
2. Call search_events() to enumerate distinct instances.
3. For each candidate, call get_session() to get exact values (amounts, counts, dates).
4. Compare explicitly: "Option X = value1, Option Y = value2."
5. State the winner with evidence.`;

const PROCEDURE_TEMPORAL = `TEMPORAL PROCEDURE:
This question asks about when something happened or the order of events.

Required steps:
1. Call search_sessions() with the event topic.
2. Call search_events() — event entries have explicit date fields.
3. If multiple sessions discuss the same event, use the earliest session date.
4. For "before/after" questions, compare timestamps explicitly.
5. State the date or time relationship clearly, citing session dates as evidence.`;

const PROCEDURE_FACTUAL = `FACTUAL PROCEDURE:
This question asks about a specific fact from the user's conversation history.

Required steps:
1. Call search_sessions() with the topic.
2. IMMEDIATELY call get_session() on the top 1-2 results to read the FULL conversation text.
   The answer is almost always in the full session text, even if the preview doesn't show it.
3. If you found the answer in the session text, answer immediately. Do not keep searching.
4. Only if get_session() did not contain the answer, try search_sessions() with different keywords,
   then get_session() on those results.
5. 2-3 search+read cycles should be sufficient.

CRITICAL: You MUST call get_session() to read sessions. Do NOT answer based only on previews,
and do NOT keep calling search_sessions/search_knowledge without reading session text first.`;

/** Map from QuestionType to its procedure text */
const PROCEDURES: Record<QuestionType, string> = {
  counting: PROCEDURE_COUNTING,
  duration: PROCEDURE_DURATION,
  comparison: PROCEDURE_COMPARISON,
  temporal: PROCEDURE_TEMPORAL,
  factual: PROCEDURE_FACTUAL,
};

/**
 * Get the step-by-step procedure text for a given question type.
 * Used to inject domain-specific retrieval instructions into the agent loop prompt.
 */
export function getProcedure(type: QuestionType): string {
  return PROCEDURES[type];
}

// ---------------------------------------------------------------------------
// Tool subsets
// ---------------------------------------------------------------------------

/** Recommended internal tool subsets per question type */
const TOOL_SUBSETS: Record<QuestionType, string[]> = {
  counting: ["search_events", "search_sessions", "get_session", "count_sessions"],
  duration: ["search_events", "search_sessions", "get_session"],
  temporal: ["search_sessions", "search_by_date", "search_events", "get_session"],
  comparison: ["search_events", "search_sessions", "get_session"],
  factual: ["search_sessions", "search_knowledge", "get_session"],
};

/**
 * Get the subset of internal tools recommended for a given question type.
 * Used to narrow the tool set exposed to the agent loop, reducing token usage
 * and preventing the model from selecting irrelevant tools.
 */
export function getToolSubset(type: QuestionType): string[] {
  return TOOL_SUBSETS[type];
}
