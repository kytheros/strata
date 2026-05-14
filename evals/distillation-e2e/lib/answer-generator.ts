import type { RetrievedTurn } from "./query-runner.js";

export interface GenerateAnswerInput {
  query: string;
  retrievedTurns: RetrievedTurn[];
}

export interface GeneratedAnswer {
  text: string;
}

const ANSWER_MODEL = "gpt-4o-2024-08-06";

/**
 * Single-turn answer synthesis using GPT-4o. Mirrors the LongMemEval answer
 * pattern: present retrieved evidence as context, ask the model to answer
 * concisely with citations.
 *
 * Context format uses session_id only — RetrievedTurn has no turn_index field
 * (knowledge store search returns per-session entries, not per-turn).
 * See query-runner.ts note 2 and plan §Task 10 v1 SCOPE.
 */
export async function generateAnswer(input: GenerateAnswerInput): Promise<GeneratedAnswer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY required for answer generation");

  const context = input.retrievedTurns
    .map((t, i) => `[${i + 1}] (${t.session_id}): ${t.content}`)
    .join("\n");

  const body = {
    model: ANSWER_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You answer questions using only the provided evidence. If the evidence is insufficient, say so.",
      },
      {
        role: "user",
        content: `Evidence:\n${context}\n\nQuestion: ${input.query}\n\nAnswer concisely.`,
      },
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
