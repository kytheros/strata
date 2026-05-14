import { describe, expect, test } from "vitest";
import { judgeAnswer } from "./judge.js";

describe("judge", () => {
  test("scores correct answer high", async () => {
    if (!process.env.OPENAI_API_KEY) return;
    const score = await judgeAnswer({
      query: "How much did the guitar cost?",
      expected: "$300",
      generated: "It cost $300.",
    });
    expect(score.score).toBe(1);
  }, 30_000);

  test("scores wrong answer low", async () => {
    if (!process.env.OPENAI_API_KEY) return;
    const score = await judgeAnswer({
      query: "How much did the guitar cost?",
      expected: "$300",
      generated: "It cost $500.",
    });
    expect(score.score).toBe(0);
  }, 30_000);
});
