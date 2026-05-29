#!/usr/bin/env tsx
/**
 * Canary-N orchestrator: runs the LongMemEval benchmark N times sequentially
 * with the same configuration, then aggregates per-question stability and
 * accuracy variance. Designed to surface GPT-4o judge nondeterminism that
 * single-run benchmarks can't detect.
 *
 * Spec: specs/2026-05-29-eval-methodology-judge-noise-design.md
 *
 * Usage:
 *   npx tsx benchmarks/longmemeval/run-canary.ts --runs=3 \
 *     --model=vertex:gemini-2.5-flash \
 *     --top-k=20 --prompt=category --session-scoring --reranker=onnx --events
 *
 *  Any flags after --runs=N are passed through to run-benchmark.ts verbatim.
 */

import { spawnSync } from "child_process";
import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");

interface RunSummary {
  taskAvg: number;
  raw: number;
  perQuestion: Array<{ questionId: string; judgeVerdict: "CORRECT" | "INCORRECT" }>;
  resultsPath: string;
}

export interface CanarySummary {
  runs: number;
  taskAvgMean: number;
  taskAvgStdDev: number;
  rawMean: number;
  rawStdDev: number;
  totalQuestions: number;
  stableCount: number;
  unstableCount: number;
  perQuestionMajority: Map<string, "CORRECT" | "INCORRECT">;
  perRunResults: Array<{ taskAvg: number; raw: number; resultsPath: string }>;
}

export function aggregateCanaryRuns(runs: RunSummary[]): CanarySummary {
  const taskAvgs = runs.map((r) => r.taskAvg);
  const raws = runs.map((r) => r.raw);
  const taskAvgMean = mean(taskAvgs);
  const rawMean = mean(raws);

  // Per-question majority verdict + stability
  const allQids = new Set<string>();
  for (const r of runs) for (const q of r.perQuestion) allQids.add(q.questionId);

  const perQuestionMajority = new Map<string, "CORRECT" | "INCORRECT">();
  let stableCount = 0;
  let unstableCount = 0;

  for (const qid of allQids) {
    const verdicts = runs
      .map((r) => r.perQuestion.find((q) => q.questionId === qid)?.judgeVerdict)
      .filter((v): v is "CORRECT" | "INCORRECT" => Boolean(v));
    const correct = verdicts.filter((v) => v === "CORRECT").length;
    const majority = correct > verdicts.length / 2 ? "CORRECT" : "INCORRECT";
    perQuestionMajority.set(qid, majority);
    if (correct === verdicts.length || correct === 0) stableCount++;
    else unstableCount++;
  }

  return {
    runs: runs.length,
    taskAvgMean,
    taskAvgStdDev: stdDev(taskAvgs, taskAvgMean),
    rawMean,
    rawStdDev: stdDev(raws, rawMean),
    totalQuestions: allQids.size,
    stableCount,
    unstableCount,
    perQuestionMajority,
    perRunResults: runs.map((r) => ({ taskAvg: r.taskAvg, raw: r.raw, resultsPath: r.resultsPath })),
  };
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function stdDev(xs: number[], m: number): number {
  if (xs.length < 2) return 0;
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

async function main() {
  const args = process.argv.slice(2);
  const runsFlag = args.find((a) => a.startsWith("--runs="));
  const runs = runsFlag ? parseInt(runsFlag.slice("--runs=".length), 10) : 3;
  if (!Number.isInteger(runs) || runs < 2) {
    console.error("--runs=N where N >= 2 required");
    process.exit(2);
  }

  const passthroughArgs = args.filter((a) => !a.startsWith("--runs="));

  const summaries: RunSummary[] = [];
  for (let i = 0; i < runs; i++) {
    console.log(`\n=== Canary Run ${i + 1}/${runs} ===`);
    const result = spawnSync(
      "npx",
      ["tsx", "benchmarks/longmemeval/run-benchmark.ts", ...passthroughArgs],
      { stdio: "inherit", shell: true }
    );
    if (result.status !== 0) {
      console.error(`Run ${i + 1} failed with exit code ${result.status}`);
      process.exit(result.status ?? 1);
    }
    // Find the most recently written results-*.json under DATA_DIR
    const latest = readdirSync(DATA_DIR)
      .filter((f) => f.startsWith("results-") && f.endsWith(".json"))
      .map((f) => ({ f, mtime: statSync(join(DATA_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0]?.f;
    if (!latest) throw new Error("Could not find results JSON after run");
    const fullPath = join(DATA_DIR, latest);
    const parsed = JSON.parse(readFileSync(fullPath, "utf8"));
    summaries.push({
      taskAvg: parsed.accuracy.taskAveraged,
      raw: parsed.accuracy.raw,
      perQuestion: parsed.perQuestion,
      resultsPath: fullPath,
    });
  }

  const summary = aggregateCanaryRuns(summaries);
  console.log(`\n=== Canary-${runs} summary ===`);
  for (let i = 0; i < summaries.length; i++) {
    console.log(
      `Run ${i + 1}: ${(summaries[i].taskAvg * 100).toFixed(1)}% task-avg, ` +
        `${(summaries[i].raw * 100).toFixed(1)}% raw`
    );
  }
  console.log(
    `Mean: ${(summary.taskAvgMean * 100).toFixed(1)}% ± ` +
      `${(summary.taskAvgStdDev * 100).toFixed(2)}pp`
  );
  console.log(
    `Stable verdicts: ${summary.stableCount}/${summary.totalQuestions} ` +
      `(${((summary.stableCount / summary.totalQuestions) * 100).toFixed(1)}%)`
  );
  console.log(
    `Unstable (flipped at least once): ${summary.unstableCount}/${summary.totalQuestions} ` +
      `(${((summary.unstableCount / summary.totalQuestions) * 100).toFixed(1)}%)`
  );

  // Persist a serializable summary (Map → array for JSON).
  const out = {
    ...summary,
    perQuestionMajority: Array.from(summary.perQuestionMajority.entries()),
  };
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(DATA_DIR, `canary-${runs}-${ts}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nCanary summary saved to ${outPath}`);
}

// Only run main when invoked as a script (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  main().catch((err) => {
    console.error("Canary failed:", err);
    process.exit(1);
  });
}
