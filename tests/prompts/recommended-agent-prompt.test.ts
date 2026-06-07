import { describe, it, expect } from "vitest";
import {
  RECOMMENDED_AGENT_SYSTEM_PROMPT,
  buildRecommendedPrompt,
} from "../../src/prompts/recommended-agent-prompt.js";

describe("recommended agent prompt", () => {
  it("substitutes context, date, and question", () => {
    const { system, user } = buildRecommendedPrompt("NOTES_BLOCK", "2026-06-07", "How much is the budget?");
    expect(system).toBe(RECOMMENDED_AGENT_SYSTEM_PROMPT);
    expect(user).toContain("NOTES_BLOCK");
    expect(user).toContain("Current Date: 2026-06-07");
    expect(user).toContain("Question: How much is the budget?");
  });

  it("is type-label-free but folds in the key disciplines", () => {
    const { user } = buildRecommendedPrompt("x", "2026-06-07", "q");
    expect(user).toContain("CHRONOLOGICAL");
    expect(user).toContain("MOST RECENT");   // knowledge-update recency
    expect(user).toMatch(/how many/i);       // counting discipline
    expect(user).toMatch(/relative dates/i); // temporal discipline
  });
});
