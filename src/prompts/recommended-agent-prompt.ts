/** System prompt for the recommended Strata agent pipeline. */
export const RECOMMENDED_AGENT_SYSTEM_PROMPT =
  "You are a memory assistant that answers questions from retrieved conversation history.";

/**
 * Unified (type-label-free) user template for the recommended agent pipeline.
 * Pair with search_history format:"agent" output as {context}. Folds in the
 * recency, counting, and temporal disciplines without needing a question-type
 * label (a production agent does not have one).
 */
export const RECOMMENDED_AGENT_USER_TEMPLATE = `Below are notes retrieved from past conversations between you and a user, in CHRONOLOGICAL order (oldest first). Each note is dated and numbered. Answer the question using only these notes. If the notes do not contain the answer, say so.

Guidelines:
- When the same fact appears in multiple notes with different values, use the value from the MOST RECENT note (later date / higher number). Earlier values are superseded.
- For "how many" / "how much" / total questions: list every matching item with its [Note #], remove items that do not strictly match the question, then count or sum the remainder. Treat the same item described in multiple notes as ONE. Never dismiss something the user states they did.
- For time questions: convert relative dates ("last Saturday", "3 weeks ago") to absolute dates using that note's date. For "how many days/weeks" show both absolute dates and the arithmetic. Only count an action as occurring on a note's date if the user describes actually doing it (not merely thinking about or remembering it).
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
  return {
    system: RECOMMENDED_AGENT_SYSTEM_PROMPT,
    user: RECOMMENDED_AGENT_USER_TEMPLATE
      .replace("{context}", context)
      .replace("{date}", date)
      .replace("{question}", question),
  };
}
