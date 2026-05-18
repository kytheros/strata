#!/usr/bin/env tsx
/**
 * Single-fixture diagnostic for the distillation harness.
 *
 * Runs ONE fixture end-to-end with full visibility — prints what gets stored,
 * what gets retrieved, what GPT-4o answers, and how the judge scores it.
 *
 * Usage:
 *   STRATA_EXTRACTION_PROVIDER=gemini npx tsx evals/distillation-e2e/scripts/diagnose-one.ts <fixture-id>
 *
 * Example:
 *   ... diagnose-one.ts compound-001
 */
import { loadFixtures } from "../lib/fixture-loader.js";
import { withIsolatedStrata } from "../lib/isolated-db.js";
import { drivePipeline } from "../lib/pipeline-driver.js";
import { runQuery } from "../lib/query-runner.js";
import { generateAnswer } from "../lib/answer-generator.js";
import { judgeAnswer } from "../lib/judge.js";
import { scoreRecall } from "../lib/recall-scorer.js";

async function main(): Promise<number> {
  const fixtureId = process.argv[2];
  if (!fixtureId) {
    console.error("usage: diagnose-one.ts <fixture-id>");
    return 1;
  }
  const all = loadFixtures("evals/distillation-e2e/fixtures");
  const fx = all.find((f) => f.id === fixtureId);
  if (!fx) {
    console.error(`fixture not found: ${fixtureId}`);
    console.error("available:", all.map((f) => f.id).join(", "));
    return 1;
  }

  console.log(`=== FIXTURE: ${fx.id} (${fx.failure_mode ?? fx.longmemeval_task_type}) ===`);
  console.log(`Query: ${fx.query}`);
  console.log(`Expected answer: ${fx.expected_answer}`);
  console.log(`Expected evidence: ${JSON.stringify(fx.expected_evidence_turns)}`);
  console.log(`Sessions: ${fx.sessions.length}, total turns: ${fx.sessions.reduce((s, x) => s + x.turns.length, 0)}`);

  await withIsolatedStrata(async (handle) => {
    console.log("\n--- STAGE 1: drivePipeline ---");
    const t0 = Date.now();
    const pipelineResult = await drivePipeline(handle, fx, {
      cacheRoot: "evals/distillation-e2e/.cache",
    });
    console.log(`drivePipeline took ${Date.now() - t0}ms`);
    console.log(`  factsWritten: ${pipelineResult.factsWritten}`);
    console.log(`  sessionsProcessed: ${pipelineResult.sessionsProcessed}`);
    console.log(`  cacheHits: ${pipelineResult.cacheHits}`);

    console.log("\n--- STAGE 2: dump knowledge store ---");
    // Pull everything in the store — no query filter — to see what landed.
    const allEntries = await handle.server.storage.knowledge.search("");
    console.log(`store has ${allEntries.length} entries`);
    for (let i = 0; i < Math.min(allEntries.length, 10); i++) {
      const e = allEntries[i];
      console.log(`  [${i}] session=${e.sessionId} summary="${e.summary.slice(0, 100)}"`);
    }
    if (allEntries.length > 10) console.log(`  ...and ${allEntries.length - 10} more`);

    console.log("\n--- STAGE 3: runQuery ---");
    const q = await runQuery(handle, fx.query, 10);
    console.log(`retrieved ${q.retrievedTurns.length} turns`);
    for (let i = 0; i < q.retrievedTurns.length; i++) {
      const t = q.retrievedTurns[i];
      console.log(`  [${i}] session=${t.session_id} score=${t.score.toFixed(2)} content="${t.content.slice(0, 100)}"`);
    }

    console.log("\n--- STAGE 4: scoreRecall ---");
    const recall = scoreRecall(
      { expected: fx.expected_evidence_turns, min_recall_at_k: fx.min_recall_at_k },
      q.retrievedTurns
    );
    console.log(`recall score: ${recall}`);

    console.log("\n--- STAGE 5: generateAnswer ---");
    const a = await generateAnswer({ query: fx.query, retrievedTurns: q.retrievedTurns });
    console.log(`generated answer: "${a.text}"`);

    console.log("\n--- STAGE 6: judgeAnswer ---");
    const j = await judgeAnswer({
      query: fx.query,
      expected: fx.expected_answer,
      generated: a.text,
    });
    console.log(`judge score: ${j.score}`);
    console.log(`judge rationale: ${j.rationale}`);
  });

  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error((e as Error).stack ?? e);
    process.exit(2);
  });
