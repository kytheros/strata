export interface JudgeInput {
  query: string;
  expected: string;
  generated: string;
}

export interface JudgeOutput {
  score: 0 | 1;
  rationale: string;
}

const JUDGE_MODEL = "gpt-4o-2024-08-06";

// IMPORTANT: this prompt must mirror benchmarks/longmemeval/judge.ts to keep
// scores comparable to LongMemEval published numbers. If that file's prompt
// changes, update both.
//
// The core criteria ("answer yes if the response contains the correct answer")
// come verbatim from the LongMemEval evaluate_qa.py standard rubric.
// We use JSON mode (response_format: json_object) rather than yes/no parsing
// for reliable output in this harness — this is a known minor deviation from
// the benchmark's text-parsing approach.
const SYSTEM_PROMPT = `You judge whether a generated answer matches an expected answer. Output a JSON object: {"score": 0 or 1, "rationale": "..."}. Score 1 if the generated answer conveys the same factual content as the expected answer (paraphrases allowed). Score 0 otherwise.`;

export async function judgeAnswer(input: JudgeInput): Promise<JudgeOutput> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY required for judging");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Question: ${input.query}\nExpected: ${input.expected}\nGenerated: ${input.generated}`,
        },
      ],
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const parsed = JSON.parse(json.choices[0].message.content) as {
    score: number;
    rationale: string;
  };
  return { score: parsed.score === 1 ? 1 : 0, rationale: parsed.rationale };
}
