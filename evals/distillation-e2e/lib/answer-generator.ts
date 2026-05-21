import type { RetrievedTurn } from "./query-runner.js";
import type { RetrievalStrategy } from "./retrieval-strategies.js";

export interface GenerateAnswerInput {
  query: string;
  retrievedTurns: RetrievedTurn[];
  /**
   * Optional. When set to "recency-weighted", the answer-generator applies
   * recency-aware prompt construction: marks rank-1-session turns as NEWEST,
   * other sessions as older, and injects a system-prompt addendum instructing
   * the model that NEWEST supersedes older for current-state questions.
   * Other values (or undefined) preserve the existing default formatting.
   *
   * Spec: 2026-05-21-temporal-answer-prompt-design.md.
   */
  strategy?: RetrievalStrategy;
}

export interface GeneratedAnswer {
  text: string;
}

const ANSWER_MODEL = "gpt-4o-2024-08-06";

const DEFAULT_SYSTEM_PROMPT =
  "You answer questions using only the provided evidence. " +
  "If the evidence is insufficient, say so.";

const RECENCY_AWARE_SYSTEM_PROMPT =
  "You answer questions using only the provided evidence. " +
  "If the evidence is insufficient, say so. " +
  "Evidence is ordered by session recency: items marked NEWEST come from the most recently-updated session. " +
  "For questions about the user's current state, statements marked NEWEST supersede statements marked older.";

/**
 * Pure prompt construction. Extracted from `generateAnswer` so prompt shape
 * is unit-testable without live OpenAI calls.
 *
 * Recency-aware path engages when:
 *   - input.strategy === "recency-weighted"
 *   - AND there are >= 2 distinct session_id values in input.retrievedTurns
 *
 * On the recency-aware path:
 *   - System prompt is replaced with the recency-aware addendum variant.
 *   - Evidence lines for the rank-1 session are tagged "NEWEST"; all other
 *     sessions are tagged "older". (The rank-1 session's session_id is taken
 *     from input.retrievedTurns[0].session_id — trusts upstream ordering
 *     produced by the recency-weighted strategy.)
 *
 * Default path otherwise — single-session results, undefined strategy,
 * and all non-recency strategies behave identically to the pre-existing
 * formatting.
 *
 * Spec: 2026-05-21-temporal-answer-prompt-design.md §5.
 */
export function buildAnswerPrompt(
  input: GenerateAnswerInput,
): { systemPrompt: string; userPrompt: string } {
  const distinctSessionIds = new Set(input.retrievedTurns.map((t) => t.session_id)).size;
  const recencyAware =
    input.strategy === "recency-weighted" && distinctSessionIds >= 2;

  let systemPrompt: string;
  let evidence: string;

  if (recencyAware) {
    systemPrompt = RECENCY_AWARE_SYSTEM_PROMPT;
    const newestSessionId = input.retrievedTurns[0].session_id;
    evidence = input.retrievedTurns
      .map((t, i) => {
        const tier = t.session_id === newestSessionId ? "NEWEST" : "older";
        return `[${i + 1}] (${tier}, session=${t.session_id}, turn=${t.turn_index}): ${t.content}`;
      })
      .join("\n");
  } else {
    systemPrompt = DEFAULT_SYSTEM_PROMPT;
    evidence = input.retrievedTurns
      .map((t, i) => `[${i + 1}] (session=${t.session_id}, turn=${t.turn_index}): ${t.content}`)
      .join("\n");
  }

  const userPrompt = `Evidence:\n${evidence}\n\nQuestion: ${input.query}\n\nAnswer concisely.`;

  return { systemPrompt, userPrompt };
}

/**
 * Single-turn answer synthesis using GPT-4o. Mirrors the LongMemEval answer
 * pattern: present retrieved evidence as context, ask the model to answer
 * concisely with citations.
 *
 * Context includes both session_id and turn_index — knowledge_turns (T9.5)
 * surfaces both so citations can be turn-level precise.
 */
export async function generateAnswer(input: GenerateAnswerInput): Promise<GeneratedAnswer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY required for answer generation");

  const { systemPrompt, userPrompt } = buildAnswerPrompt(input);

  const body = {
    model: ANSWER_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0,
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return { text: json.choices[0].message.content };
}
