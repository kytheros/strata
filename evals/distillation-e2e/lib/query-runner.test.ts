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
  test("defaults to 'turns' strategy (T17 baseline reproducibility)", async () => {
    process.env.STRATA_EXTRACTION_PROVIDER = "gemini";
    await withIsolatedStrata(async (handle) => {
      await drivePipeline(handle, sampleFixture, { skipExtraction: true });
      const result = await runQuery(handle, "guitar cost"); // no strategy arg
      expect(result.retrievedTurns.length).toBeGreaterThan(0);
      expect(result.retrievedTurns[0].session_id).toBe("s1");
      expect(result.retrievedTurns[0].turn_index).toBe(0);
    });
  }, 30_000);

  test("accepts an explicit strategy and dispatches to retrieveTurns", async () => {
    process.env.STRATA_EXTRACTION_PROVIDER = "gemini";
    await withIsolatedStrata(async (handle) => {
      await drivePipeline(handle, sampleFixture, { skipExtraction: true });
      const result = await runQuery(handle, "guitar cost", 10, "turns");
      expect(result.retrievedTurns.length).toBeGreaterThan(0);
      expect(result.retrievedTurns[0].turn_index).toBe(0);
    });
  }, 30_000);
});
