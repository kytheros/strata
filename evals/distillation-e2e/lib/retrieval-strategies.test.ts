import { describe, expect, test } from "vitest";
import { withIsolatedStrata } from "./isolated-db.js";
import { retrieveTurns, type RetrievalStrategy } from "./retrieval-strategies.js";
import { drivePipeline } from "./pipeline-driver.js";
import type { Fixture } from "./fixture-types.js";

const STRATEGIES: RetrievalStrategy[] = ["turns", "entries", "rrf-both", "tirqdp", "legacy"];

const guitarFixture: Fixture = {
  id: "rs-guitar-001",
  source: "hand-annotated",
  failure_mode: "compound",
  longmemeval_task_type: null,
  sessions: [{
    id: "rsg1",
    turns: [
      { role: "user", content: "I bought a guitar last week. It cost $300." },
      { role: "assistant", content: "Got it." },
    ],
  }],
  query: "How much did the guitar cost?",
  expected_answer: "$300",
  expected_evidence_turns: [{ session_id: "rsg1", turn_index: 0 }],
  min_recall_at_k: 1,
};

describe("retrieval-strategies — dispatch shape", () => {
  test("every strategy returns an array with the expected RetrievedTurn shape", async () => {
    await withIsolatedStrata(async (handle) => {
      for (const strategy of STRATEGIES) {
        const out = await retrieveTurns(handle, "anything", 5, strategy);
        expect(Array.isArray(out)).toBe(true);
        // Empty corpus → empty result, but the shape contract still applies.
        for (const t of out) {
          expect(typeof t.session_id).toBe("string");
          expect(typeof t.turn_index).toBe("number");
          expect(typeof t.content).toBe("string");
          expect(typeof t.score).toBe("number");
        }
      }
    });
  }, 30_000);
});

describe("retrieval-strategies — turns lane", () => {
  test("retrieveTurns('turns', ...) returns the matching turn from knowledge_turns", async () => {
    // resolveProvider() is called inside drivePipeline even when skipExtraction=true.
    // Set a sentinel value so the guard passes without touching a real LLM.
    process.env.STRATA_EXTRACTION_PROVIDER = "gemini";
    await withIsolatedStrata(async (handle) => {
      await drivePipeline(handle, guitarFixture, { skipExtraction: true });
      const out = await retrieveTurns(handle, "guitar cost", 5, "turns");
      expect(out.length).toBeGreaterThan(0);
      expect(out[0].session_id).toBe("rsg1");
      expect(out[0].turn_index).toBe(0);
      expect(out[0].content).toMatch(/guitar/i);
    });
  }, 30_000);
});

describe("retrieval-strategies — entries lane", () => {
  test("retrieveTurns('entries', ...) returns extracted facts from knowledge_entries", async () => {
    if (!process.env.GEMINI_API_KEY) return; // entries requires real extraction
    process.env.STRATA_EXTRACTION_PROVIDER = "gemini";
    await withIsolatedStrata(async (handle) => {
      await drivePipeline(handle, guitarFixture); // extraction enabled
      const out = await retrieveTurns(handle, "guitar cost", 5, "entries");
      expect(out.length).toBeGreaterThan(0);
      expect(out[0].session_id).toBe("rsg1");
      expect(out[0].turn_index).toBe(-1); // entries are per-session, not per-turn
      expect(out[0].content).toMatch(/\$300|guitar/i);
    });
  }, 180_000);
});

describe("retrieval-strategies — rrf-both lane", () => {
  test("retrieveTurns('rrf-both', ...) fuses turns + entries and returns the top match", async () => {
    if (!process.env.GEMINI_API_KEY) return;
    process.env.STRATA_EXTRACTION_PROVIDER = "gemini";
    await withIsolatedStrata(async (handle) => {
      await drivePipeline(handle, guitarFixture); // populates both knowledge_turns and knowledge_entries
      const out = await retrieveTurns(handle, "guitar cost", 5, "rrf-both");
      expect(out.length).toBeGreaterThan(0);
      // The fused list must mention the $300 / guitar evidence somewhere in the top-k.
      const hasMatch = out.some((t) => /\$300|guitar/i.test(t.content));
      expect(hasMatch).toBe(true);
    });
  }, 180_000);
});

describe("retrieval-strategies — tirqdp lane", () => {
  test("retrieveTurns('tirqdp', ...) returns RRF+QDP-pruned results", async () => {
    if (!process.env.GEMINI_API_KEY) return;
    process.env.STRATA_EXTRACTION_PROVIDER = "gemini";
    await withIsolatedStrata(async (handle) => {
      await drivePipeline(handle, guitarFixture);
      const out = await retrieveTurns(handle, "guitar cost", 5, "tirqdp");
      expect(out.length).toBeGreaterThan(0);
      const hasMatch = out.some((t) => /\$300|guitar/i.test(t.content));
      expect(hasMatch).toBe(true);
    });
  }, 180_000);
});

describe("retrieval-strategies — legacy lane", () => {
  test("retrieveTurns('legacy', ...) returns entries-only results (no chunk index in harness)", async () => {
    if (!process.env.GEMINI_API_KEY) return;
    process.env.STRATA_EXTRACTION_PROVIDER = "gemini";
    await withIsolatedStrata(async (handle) => {
      await drivePipeline(handle, guitarFixture);
      const out = await retrieveTurns(handle, "guitar cost", 5, "legacy");
      expect(out.length).toBeGreaterThan(0);
      // legacy reduces to entries in the harness — turn_index = -1 sentinel.
      expect(out[0].turn_index).toBe(-1);
    });
  }, 180_000);
});
