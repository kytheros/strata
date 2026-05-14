import { describe, expect, test } from "vitest";
import { generateAnswer } from "./answer-generator.js";
import type { RetrievedTurn } from "./query-runner.js";

describe("answer-generator", () => {
  test("synthesizes an answer from retrieved turns using GPT-4o", async () => {
    if (!process.env.OPENAI_API_KEY) return;
    const turns: RetrievedTurn[] = [
      { session_id: "s1", content: "I bought a guitar for $300 last week.", score: 0.9 },
    ];
    const answer = await generateAnswer({
      query: "How much did the guitar cost?",
      retrievedTurns: turns,
    });
    expect(answer.text).toMatch(/300/);
  }, 30_000);
});
