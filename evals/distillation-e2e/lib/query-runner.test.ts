import { describe, expect, test } from "vitest";
import { withIsolatedStrata } from "./isolated-db.js";
import { runQuery } from "./query-runner.js";
import { drivePipeline } from "./pipeline-driver.js";
import type { Fixture } from "./fixture-types.js";

const sampleFixture: Fixture = {
  id: "qr-smoke-001",
  source: "hand-annotated",
  failure_mode: "compound",
  longmemeval_task_type: null,
  sessions: [{
    id: "s1",
    turns: [
      { role: "user", content: "I bought a guitar last week. It cost $300." },
      { role: "assistant", content: "Got it." },
    ],
  }],
  query: "How much did the guitar cost?",
  expected_answer: "$300",
  expected_evidence_turns: [{ session_id: "s1", turn_index: 0 }],
  min_recall_at_k: 1,
};

describe("query-runner", () => {
  test("returns retrieved turns with session_id metadata", async () => {
    if (!process.env.GEMINI_API_KEY) return;
    process.env.STRATA_EXTRACTION_PROVIDER = "gemini";
    await withIsolatedStrata(async (handle) => {
      // Pre-seed: drive the fixture through real extraction first.
      await drivePipeline(handle, sampleFixture);

      const result = await runQuery(handle, "guitar cost");
      expect(result.retrievedTurns.length).toBeGreaterThan(0);
      expect(result.retrievedTurns[0]).toHaveProperty("session_id");
      expect(result.retrievedTurns[0]).toHaveProperty("score");
      expect(result.retrievedTurns[0]).toHaveProperty("content");
    });
  }, 180_000);
});
