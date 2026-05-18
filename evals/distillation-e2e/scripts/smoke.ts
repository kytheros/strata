#!/usr/bin/env tsx
/**
 * L3 smoke harness for the distillation E2E pipeline.
 *
 * Runs 5 representative hand-annotated fixtures through the full
 * drivePipeline → runQuery → generateAnswer → judgeAnswer flow,
 * with per-fixture visibility on each stage. Asserts non-zero scores
 * as the definition-of-done for any harness change.
 *
 * EXPECTED behavior after T9.5 (knowledge_turns wiring):
 *   - All 5 fixtures should have recall=1.0 AND answer=1.0
 *   - Total wall < 2 min (cached) / < 5 min (cold)
 *
 * Usage:
 *   STRATA_EXTRACTION_PROVIDER=gemini npx tsx evals/distillation-e2e/scripts/smoke.ts
 *
 * Exit code:
 *   0 — all 5 fixtures passed (recall=1.0 AND answer=1.0)
 *   1 — at least one fixture failed
 *   2 — fatal error
 */
import { loadFixtures } from "../lib/fixture-loader.js";
import { withIsolatedStrata } from "../lib/isolated-db.js";
import { drivePipeline } from "../lib/pipeline-driver.js";
import { runQuery } from "../lib/query-runner.js";
import { generateAnswer } from "../lib/answer-generator.js";
import { judgeAnswer } from "../lib/judge.js";
import { scoreRecall } from "../lib/recall-scorer.js";

// Five representative hand-annotated fixtures — mix of failure modes,
// all small (1-2 sessions, 2-4 turns) so the smoke runs fast.
const SMOKE_FIXTURE_IDS = [
  "compound-001",          // single-clause value buried in compound assertion
  "code_identifier-001",   // code identifier as the answer
  "temporal-001",          // 2 sessions, newer-wins
  "tool_output_buried-001", // answer buried in code-block tool output
  "coreference-001",       // pronoun resolves across turns
];

interface SmokeResult {
  id: string;
  failureMode: string | null;
  factsWritten: number;
  storeEntries: number;
  retrievedCount: number;
  recall: number;
  answerText: string;
  expectedAnswer: string;
  answerScore: number;
  judgeRationale: string;
  elapsedMs: number;
}

function passes(r: SmokeResult): boolean {
  return r.recall >= 1.0 && r.answerScore >= 1.0;
}

async function main(): Promise<number> {
  const all = loadFixtures("evals/distillation-e2e/fixtures");
  const fixtures = SMOKE_FIXTURE_IDS.map((id) => {
    const fx = all.find((f) => f.id === id);
    if (!fx) throw new Error(`smoke fixture not found: ${id}`);
    return fx;
  });

  console.log(`L3 smoke — ${fixtures.length} fixtures`);
  console.log(`provider: ${process.env.STRATA_EXTRACTION_PROVIDER ?? "(default)"}`);
  console.log("");

  const results: SmokeResult[] = [];
  const wallStart = Date.now();

  // Per-fixture isolation: each fixture gets a fresh isolated server so
  // turns from one fixture don't contaminate another's retrieval set.
  for (const fx of fixtures) {
    const r = await withIsolatedStrata(async (handle): Promise<SmokeResult> => {
      const t0 = Date.now();
      const pipelineResult = await drivePipeline(handle, fx, {
        cacheRoot: "evals/distillation-e2e/.cache",
      });
      const allEntries = await handle.server.storage.knowledge.search("");
      const q = await runQuery(handle, fx.query, 10);
      const a = await generateAnswer({ query: fx.query, retrievedTurns: q.retrievedTurns });
      const j = await judgeAnswer({
        query: fx.query,
        expected: fx.expected_answer,
        generated: a.text,
      });
      const recall = scoreRecall(
        { expected: fx.expected_evidence_turns, min_recall_at_k: fx.min_recall_at_k },
        q.retrievedTurns
      );

      return {
        id: fx.id,
        failureMode: fx.failure_mode,
        factsWritten: pipelineResult.factsWritten,
        storeEntries: allEntries.length,
        retrievedCount: q.retrievedTurns.length,
        recall,
        answerText: a.text,
        expectedAnswer: fx.expected_answer,
        answerScore: j.score,
        judgeRationale: j.rationale,
        elapsedMs: Date.now() - t0,
      };
    });
    results.push(r);

    const marker = passes(r) ? "PASS" : "FAIL";
    console.log(`[${marker}] ${r.id} (${r.failureMode}) — ${r.elapsedMs}ms`);
    console.log(`  facts_written=${r.factsWritten} store=${r.storeEntries} retrieved=${r.retrievedCount}`);
    console.log(`  recall=${r.recall.toFixed(2)} answer=${r.answerScore.toFixed(2)}`);
    console.log(`  expected: "${r.expectedAnswer}"`);
    console.log(`  generated: "${r.answerText.slice(0, 200)}${r.answerText.length > 200 ? "…" : ""}"`);
    if (!passes(r)) {
      console.log(`  judge: ${r.judgeRationale.slice(0, 200)}`);
    }
    console.log("");
  }

  const wallMs = Date.now() - wallStart;
  const passCount = results.filter(passes).length;
  console.log(`=== summary: ${passCount}/${results.length} passed (${(wallMs / 1000).toFixed(1)}s total) ===`);
  console.log(
    "pass criteria per fixture: recall >= 1.0 AND answer >= 1.0"
  );

  return passCount === results.length ? 0 : 1;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error((e as Error).stack ?? e);
    process.exit(2);
  });
