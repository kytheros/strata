#!/usr/bin/env tsx
import { applyIntegrityGate, resolveProvider } from "./lib/integrity-gate.js";
import { loadFixtures } from "./lib/fixture-loader.js";
import { withIsolatedStrata } from "./lib/isolated-db.js";
import { drivePipeline } from "./lib/pipeline-driver.js";
import { runQuery } from "./lib/query-runner.js";
import { generateAnswer } from "./lib/answer-generator.js";
import { judgeAnswer } from "./lib/judge.js";
import { scoreRecall } from "./lib/recall-scorer.js";
import { aggregate, type FixtureResult } from "./lib/aggregator.js";
import { withNAveraging } from "./lib/n-strategy.js";
import { writeRunRecord, formatComparisonTable, type RunRecord } from "./lib/reporter.js";
import { failureModeToStrategy } from "./lib/failure-mode-strategy.js";
import { parseArgs } from "node:util";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { CONFIG } from "../../src/config.js";

async function main(): Promise<number> {
  applyIntegrityGate();
  const provider = resolveProvider();

  const { values } = parseArgs({
    options: {
      "fixtures-dir": { type: "string", default: "evals/distillation-e2e/fixtures" },
      "cache-dir": { type: "string", default: "evals/distillation-e2e/.cache" },
      "runs-dir": { type: "string", default: "evals/distillation-e2e/runs" },
      decision: { type: "boolean", default: false },
    },
  });

  const fixtures = loadFixtures(values["fixtures-dir"]!);
  process.stdout.write(`loaded ${fixtures.length} fixtures\n`);

  // Compute a stable hash of the retrieval config so run records capture
  // exactly which parameter set produced the scores. Keys match CONFIG shape
  // confirmed in src/config.ts (bm25, search, indexing, importance).
  const retrievalConfigHash = createHash("sha256")
    .update(
      JSON.stringify({
        bm25: CONFIG.bm25,
        search: CONFIG.search,
        indexing: CONFIG.indexing,
        importance: CONFIG.importance,
      })
    )
    .digest("hex")
    .slice(0, 12);

  const startWall = Date.now();
  const results: FixtureResult[] = [];

  // Per-fixture isolation: each fixture gets a fresh isolated server so
  // turns from one fixture don't contaminate another's retrieval set.
  let idx = 0;
  for (const fx of fixtures) {
    idx += 1;
    const fxStart = Date.now();
    const strategy = fx.retrieval_strategy ?? failureModeToStrategy(fx.failure_mode, fx.longmemeval_task_type);
    process.stdout.write(
      `[${idx}/${fixtures.length}] ${fx.id} (${fx.failure_mode ?? fx.longmemeval_task_type ?? "?"}, strategy=${strategy}) starting...\n`
    );
    const scored = await withIsolatedStrata(async (handle) => {
      await drivePipeline(handle, fx, {
        cacheRoot: values["cache-dir"],
      });
      return withNAveraging(values.decision ? 3 : 1, async () => {
        const q = await runQuery(handle, fx.query, 10, strategy);
        const a = await generateAnswer({ query: fx.query, retrievedTurns: q.retrievedTurns, strategy });
        const j = await judgeAnswer({
          query: fx.query,
          expected: fx.expected_answer,
          generated: a.text,
        });
        const recall = scoreRecall(
          { expected: fx.expected_evidence_turns, min_recall_at_k: fx.min_recall_at_k },
          q.retrievedTurns
        );
        return { answerScore: j.score, recallScore: recall };
      });
    });
    results.push({
      id: fx.id,
      failure_mode: fx.failure_mode,
      longmemeval_task_type: fx.longmemeval_task_type,
      retrieval_strategy: strategy,
      answerScore: scored.answerScore,
      recallScore: scored.recallScore,
    });
    const elapsedMs = Date.now() - fxStart;
    const totalElapsedSec = ((Date.now() - startWall) / 1000).toFixed(0);
    const etaSec = idx < fixtures.length
      ? ((Date.now() - startWall) / idx * (fixtures.length - idx) / 1000).toFixed(0)
      : "0";
    process.stdout.write(
      `[${idx}/${fixtures.length}] ${fx.id} done — answer=${scored.answerScore.toFixed(2)} recall=${scored.recallScore.toFixed(2)} (${(elapsedMs / 1000).toFixed(1)}s; total ${totalElapsedSec}s; ETA ${etaSec}s)\n`
    );
  }

  const agg = aggregate(results);
  const gitSha = execSync("git rev-parse --short HEAD").toString().trim();

  const extractionModel =
    provider.kind === "ollama"
      ? provider.model
      : provider.kind === "hybrid"
      ? "hybrid(gemma4/gemini-2.5-flash)"
      : "gemini-2.5-flash";

  const record: RunRecord = {
    timestamp: new Date().toISOString(),
    gitSha,
    provider,
    modelVersions: {
      extraction: extractionModel,
      summarization: extractionModel,
      conflict: extractionModel,
      judge: "gpt-4o-2024-08-06",
    },
    retrievalConfigHash,
    ollamaParallel: Number(process.env.OLLAMA_NUM_PARALLEL ?? "1"),
    nValue: values.decision ? 3 : 1,
    wallTimeMs: Date.now() - startWall,
    fixtureCount: fixtures.length,
    scores: {
      answerAccuracy: agg.overall.answerAccuracy,
      recallAt10: agg.overall.recallAt10,
      perFailureMode: agg.perFailureMode,
      perTaskType: agg.perTaskType,
    },
  };

  const path = writeRunRecord(values["runs-dir"]!, record);
  process.stdout.write(
    `\n${formatComparisonTable([{ label: JSON.stringify(provider), record }])}\n`
  );
  process.stdout.write(`run record: ${path}\n`);
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    process.stderr.write(`${(e as Error).stack ?? e}\n`);
    process.exit(2);
  });
