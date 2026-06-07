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

  it("does not let retrieved context containing {date} or {question} steal the template placeholder", () => {
    // If context contains literal "{date}" or "{question}", the naive .replace() chain
    // would substitute the context value THEN replace the newly-inserted {date}/{question}
    // tokens, corrupting the output. The safe implementation substitutes in one pass so
    // already-substituted values are never re-scanned.
    const context = "The config changed on {date} per {question}.";
    const { user } = buildRecommendedPrompt(context, "2026-06-07", "What changed?");
    // Real template tokens must be resolved exactly once.
    expect(user).toContain("Current Date: 2026-06-07");
    expect(user).toContain("Question: What changed?");
    // The context substring must survive verbatim (not have its {date}/{question} replaced).
    expect(user).toContain("changed on {date} per {question}.");
  });
});
