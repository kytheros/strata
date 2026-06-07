/** System prompt for the recommended Strata agent pipeline. */
export const RECOMMENDED_AGENT_SYSTEM_PROMPT =
  "You are a memory assistant that answers questions from retrieved conversation history.";

/**
 * Unified (type-label-free) user template for the recommended agent pipeline.
 * Pair with search_history format:"agent" output as {context}. Folds in the
 * recency, counting, temporal, AND preference disciplines unconditionally so it
 * matches the per-category benchmark prompts without needing a question-type
 * label (a production agent does not have one). The PREFERENCES bullet is the
 * anti-abstention guidance that recovers single-session-preference accuracy.
 */
export const RECOMMENDED_AGENT_USER_TEMPLATE = `Below are notes retrieved from past conversations between you and a user, in CHRONOLOGICAL order (oldest first). Each note is dated and numbered. Answer the question using only these notes. If the notes genuinely do not contain the answer, say so.

Guidelines:
- RECENCY: when the same fact, value, or status appears in multiple notes, the value in the MOST RECENT note (later date / higher number) is current — earlier values are superseded. Use the latest.
- COUNTING / TOTALS ("how many", "how much", totals): list every matching item individually with its [Note #], drop items that do not strictly match the question, then count or sum what remains. Treat the same item described in multiple notes as ONE. Never dismiss something the user states they did.
- TIME: convert relative dates ("last Saturday", "3 weeks ago", "yesterday") to absolute dates using that note's own date. For "how many days/weeks" questions, show both absolute dates and the arithmetic. For ordering questions, list each event with its absolute date, then sort. Only count an action as happening on a note's date if the user describes actually doing it (not merely thinking about or remembering it).
- PREFERENCES / RECOMMENDATIONS / personal details: base the answer on what the user has explicitly stated in the notes. Do NOT claim you lack information if the notes contain ANY relevant preference, and look for RELATED preferences even when the exact topic is not mentioned. Cite at least one specific detail from the notes — generic advice is wrong.
- Give a direct, concise answer.

Notes:

{context}

Current Date: {date}
Question: {question}
Answer:`;

/** Build the recommended system+user prompt for a question. */
export function buildRecommendedPrompt(
  context: string,
  date: string,
  question: string,
): { system: string; user: string } {
  const map: Record<string, string> = { "{context}": context, "{date}": date, "{question}": question };
  return {
    system: RECOMMENDED_AGENT_SYSTEM_PROMPT,
    user: RECOMMENDED_AGENT_USER_TEMPLATE.replace(/\{(context|date|question)\}/g, (m) => map[m] ?? m),
  };
}
