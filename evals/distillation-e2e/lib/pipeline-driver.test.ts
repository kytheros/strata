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

// ── Task 5: synthetic createdAt fallback ─────────────────────────────────────

import { SYNTHETIC_BASE_MS, SYNTHETIC_SESSION_GAP_MS } from "./pipeline-driver.js";

const multiSessionFixture: Fixture = {
  id: "ts-fallback-001",
  source: "hand-annotated",
  failure_mode: "temporal",
  longmemeval_task_type: null,
  sessions: [
    { id: "s1", turns: [{ role: "user", content: "first session content" }] },
    { id: "s2", turns: [{ role: "user", content: "second session content" }] },
    { id: "s3", turns: [{ role: "user", content: "third session content" }] },
  ],
  query: "anything",
  expected_answer: "n/a",
  expected_evidence_turns: [],
  min_recall_at_k: 0,
};

describe("pipeline-driver — synthetic createdAt fallback", () => {
  test("session N+1 gets a strictly newer createdAt than session N (no explicit created_at)", async () => {
    process.env.STRATA_EXTRACTION_PROVIDER = "gemini";
    await withIsolatedStrata(async (handle) => {
      await drivePipeline(handle, multiSessionFixture, { skipExtraction: true });
      const s1 = await handle.knowledgeTurn.getBySessionId("s1");
      const s2 = await handle.knowledgeTurn.getBySessionId("s2");
      const s3 = await handle.knowledgeTurn.getBySessionId("s3");
      expect(s1[0].createdAt).toBe(SYNTHETIC_BASE_MS + 0);
      expect(s2[0].createdAt).toBe(SYNTHETIC_BASE_MS + SYNTHETIC_SESSION_GAP_MS);
      expect(s3[0].createdAt).toBe(SYNTHETIC_BASE_MS + 2 * SYNTHETIC_SESSION_GAP_MS);
    });
  }, 30_000);

  test("explicit created_at on a session is respected", async () => {
    process.env.STRATA_EXTRACTION_PROVIDER = "gemini";
    const explicitFixture: Fixture = {
      ...multiSessionFixture,
      id: "ts-explicit-001",
      sessions: [
        { id: "e1", created_at: 5000, turns: [
          { role: "user", content: "msg0" },
          { role: "user", content: "msg1" },
        ]},
      ],
    };
    await withIsolatedStrata(async (handle) => {
      await drivePipeline(handle, explicitFixture, { skipExtraction: true });
      const rows = await handle.knowledgeTurn.getBySessionId("e1");
      expect(rows).toHaveLength(2);
      expect(rows[0].createdAt).toBe(5000 + 0);
      expect(rows[1].createdAt).toBe(5000 + 1);
    });
  }, 30_000);
});

// ── Original smoke tests ──────────────────────────────────────────────────────

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
