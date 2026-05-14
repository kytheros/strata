import { describe, expect, test } from "vitest";
import { withIsolatedStrata } from "./isolated-db.js";
import { drivePipeline } from "./pipeline-driver.js";
import type { Fixture } from "./fixture-types.js";

const sampleFixture: Fixture = {
  id: "smoke-001",
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

describe("pipeline-driver smoke", () => {
  test("drives a fixture's sessions through real extraction and stores facts", async () => {
    if (!process.env.GEMINI_API_KEY) {
      // Smoke test requires a real provider; skip in CI without keys.
      return;
    }
    process.env.STRATA_EXTRACTION_PROVIDER = "gemini";
    await withIsolatedStrata(async (handle) => {
      const result = await drivePipeline(handle, sampleFixture);
      expect(result.factsWritten).toBeGreaterThan(0);
    });
  }, 180_000);

  // Task 8: second call with same provider+session+prompt is a cache hit
  test("second call with same provider+session+prompt is a cache hit", async () => {
    if (!process.env.GEMINI_API_KEY) return;
    process.env.STRATA_EXTRACTION_PROVIDER = "gemini";
    await withIsolatedStrata(async (handle) => {
      const t1 = Date.now();
      await drivePipeline(handle, sampleFixture, { cacheRoot: handle.dataDir + "/cache" });
      const elapsed1 = Date.now() - t1;

      const t2 = Date.now();
      await drivePipeline(handle, sampleFixture, { cacheRoot: handle.dataDir + "/cache" });
      const elapsed2 = Date.now() - t2;

      // Second call should be at least 10x faster (extraction was the slow part)
      expect(elapsed2 * 10).toBeLessThan(elapsed1);
    });
  }, 240_000);
});
