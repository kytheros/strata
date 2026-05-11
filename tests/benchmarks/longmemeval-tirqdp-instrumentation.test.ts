/**
 * Tests for Stage 1.5 — benchmark instrumentation gap closure.
 *
 * Verifies that:
 * 1. ingestQuestion() populates the knowledge_turns table
 * 2. handleSearchHistory with useTirQdp=true produces source:"turn" results
 * 3. handleSearchHistory with useTirQdp=false produces no source:"turn" results
 *
 * These tests gate whether --flag on and --flag off can produce different numbers.
 *
 * Ticket: kytheros/strata#5 (Stage 1.5)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CONFIG } from "../../src/config.js";
import { ingestQuestion, closeIngested } from "../../benchmarks/longmemeval/ingest.js";
import { handleSearchHistory } from "../../src/tools/search-history.js";
import type { LongMemQuestion } from "../../benchmarks/longmemeval/types.js";

// ---------------------------------------------------------------------------
// Minimal fixture: a LongMemEval question with 2 haystack sessions
// ---------------------------------------------------------------------------

function makeFixtureQuestion(): LongMemQuestion {
  return {
    question_id: "test-tirqdp-001",
    question_type: "single-session-user",
    question: "What programming language did the user say they prefer?",
    answer: "Python",
    question_date: "2023/06/01 (Thu) 10:00",
    haystack_sessions: [
      [
        { role: "user", content: "I really prefer Python for data science work." },
        { role: "assistant", content: "Python is excellent for data science with pandas and numpy." },
      ],
      [
        { role: "user", content: "I started a new project using TypeScript this week." },
        { role: "assistant", content: "TypeScript adds great type safety to JavaScript projects." },
      ],
    ],
    haystack_session_ids: ["session-a", "session-b"],
    haystack_dates: ["2023/05/01 (Mon) 09:00", "2023/05/15 (Mon) 10:00"],
    answer_session_ids: ["session-a"],
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("LongMemEval benchmark TIRQDP instrumentation (Stage 1.5)", () => {
  const originalFlag = CONFIG.search.useTirQdp;

  afterEach(() => {
    CONFIG.search.useTirQdp = originalFlag;
  });

  // ── 1. turn store is populated after ingest ────────────────────────────

  it("ingestQuestion populates knowledge_turns with at least one row per turn", async () => {
    const question = makeFixtureQuestion();
    const ingested = await ingestQuestion(question);

    try {
      // turnStore must exist on IngestedQuestion (this will fail pre-fix: RED)
      expect(ingested).toHaveProperty("turnStore");

      const count = await ingested.turnStore.count();
      // 2 sessions × 2 turns each = 4 turns minimum
      expect(count).toBeGreaterThanOrEqual(4);
    } finally {
      closeIngested(ingested);
    }
  });

  // ── 2. flag=on produces source:"turn" in results ───────────────────────

  it("handleSearchHistory with useTirQdp=true includes source:turn results", async () => {
    CONFIG.search.useTirQdp = true;

    const question = makeFixtureQuestion();
    const ingested = await ingestQuestion(question);

    try {
      expect(ingested).toHaveProperty("turnStore");

      const result = await handleSearchHistory(
        ingested.searchEngine,
        { query: "Python programming language", format: "detailed" },
        ingested.db,
        undefined,
        undefined, // knowledgeStore not needed for this assertion
        ingested.turnStore,
      );

      expect(result).not.toContain("No results found");
      // Must include at least one turn-sourced result
      expect(result).toContain('"source":"turn"');
    } finally {
      closeIngested(ingested);
    }
  });

  // ── 3. flag=off produces no source:"turn" in results ──────────────────

  it("handleSearchHistory with useTirQdp=false has no source:turn results", async () => {
    CONFIG.search.useTirQdp = false;

    const question = makeFixtureQuestion();
    const ingested = await ingestQuestion(question);

    try {
      const result = await handleSearchHistory(
        ingested.searchEngine,
        { query: "Python programming language", format: "detailed" },
        ingested.db,
        undefined,
        undefined,
        ingested.turnStore,
      );

      expect(result).not.toContain('"source":"turn"');
    } finally {
      closeIngested(ingested);
    }
  });
});
