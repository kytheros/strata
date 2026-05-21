import { describe, expect, test } from "vitest";
import { generateAnswer } from "./answer-generator.js";
import { buildAnswerPrompt } from "./answer-generator.js";
import type { RetrievedTurn } from "./query-runner.js";

describe("answer-generator", () => {
  test("synthesizes an answer from retrieved turns using GPT-4o", async () => {
    if (!process.env.OPENAI_API_KEY) return;
    const turns: RetrievedTurn[] = [
      { session_id: "s1", turn_index: 0, content: "I bought a guitar for $300 last week.", score: 0.9 },
    ];
    const answer = await generateAnswer({
      query: "How much did the guitar cost?",
      retrievedTurns: turns,
    });
    expect(answer.text).toMatch(/300/);
  }, 30_000);
});

const twoSessionTurns: RetrievedTurn[] = [
  { session_id: "t1sess002", turn_index: 0, content: "Heads up — I bumped Strata to Node 22 last week.", score: 1.0 },
  { session_id: "t1sess002", turn_index: 1, content: "Makes sense. Did the husky hook scripts need any changes?", score: 0.75 },
  { session_id: "t1sess001", turn_index: 0, content: "I'm on Node 20 for all Strata repos right now.", score: 0.5 },
  { session_id: "t1sess001", turn_index: 1, content: "Node 20 is LTS through April 2026.", score: 0.25 },
];

const oneSessionTurns: RetrievedTurn[] = [
  { session_id: "sole", turn_index: 0, content: "first", score: 1.0 },
  { session_id: "sole", turn_index: 1, content: "second", score: 0.5 },
];

describe("buildAnswerPrompt — recency-aware formatting", () => {
  test("tags rank-1 session turns as NEWEST and other sessions as older when strategy === recency-weighted", () => {
    const { userPrompt } = buildAnswerPrompt({
      query: "What Node version is the user on?",
      retrievedTurns: twoSessionTurns,
      strategy: "recency-weighted",
    });
    expect(userPrompt).toContain("[1] (NEWEST, session=t1sess002, turn=0)");
    expect(userPrompt).toContain("[2] (NEWEST, session=t1sess002, turn=1)");
    expect(userPrompt).toContain("[3] (older, session=t1sess001, turn=0)");
    expect(userPrompt).toContain("[4] (older, session=t1sess001, turn=1)");
  });

  test("includes the recency-aware system prompt addendum when strategy === recency-weighted (multi-session)", () => {
    const { systemPrompt } = buildAnswerPrompt({
      query: "What Node version is the user on?",
      retrievedTurns: twoSessionTurns,
      strategy: "recency-weighted",
    });
    expect(systemPrompt).toContain("NEWEST");
    expect(systemPrompt).toContain("supersede");
  });

  test("falls back to default formatting when strategy === recency-weighted but all turns share one session", () => {
    const { systemPrompt, userPrompt } = buildAnswerPrompt({
      query: "any",
      retrievedTurns: oneSessionTurns,
      strategy: "recency-weighted",
    });
    expect(userPrompt).not.toContain("NEWEST");
    expect(userPrompt).not.toContain("older");
    expect(userPrompt).toContain("[1] (session=sole, turn=0)");
    expect(systemPrompt).not.toContain("supersede");
  });

  test("uses default formatting for non-recency strategies", () => {
    for (const strategy of ["turns", "entries", "rrf-both", "tirqdp", "legacy"] as const) {
      const { systemPrompt, userPrompt } = buildAnswerPrompt({
        query: "any",
        retrievedTurns: twoSessionTurns,
        strategy,
      });
      expect(userPrompt).not.toContain("NEWEST");
      expect(systemPrompt).not.toContain("supersede");
    }
  });

  test("uses default formatting when strategy is undefined (back-compat)", () => {
    const { systemPrompt, userPrompt } = buildAnswerPrompt({
      query: "any",
      retrievedTurns: twoSessionTurns,
    });
    expect(userPrompt).not.toContain("NEWEST");
    expect(systemPrompt).not.toContain("supersede");
  });
});
