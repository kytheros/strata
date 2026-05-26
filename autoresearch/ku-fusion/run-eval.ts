/**
 * AutoResearch eval: KU-gated turn-lane fusion answer accuracy
 *
 * Frozen eval on the 78 knowledge-update questions from
 * data/longmemeval_oracle.json. Runs the LongMemEval benchmark in full
 * answer-generation mode with the configured kuFusion.mode and reports
 * task-averaged accuracy.
 *
 * Spec: 2026-05-26-b2-ku-fusion-design §6.3
 *
 * Usage:
 *   STRATA_KU_FUSION_MODE=off    npx tsx autoresearch/ku-fusion/run-eval.ts
 *   STRATA_KU_FUSION_MODE=append npx tsx autoresearch/ku-fusion/run-eval.ts
 *   STRATA_KU_FUSION_MODE=rrf    npx tsx autoresearch/ku-fusion/run-eval.ts
 *
 * Smoke-test override (slices to N IDs without modifying the oracle):
 *   STRATA_KU_FUSION_SMOKE_IDS="id1,id2,id3" npx tsx autoresearch/ku-fusion/run-eval.ts
 *
 * Requires: GEMINI_API_KEY (answer) + OPENAI_API_KEY (judge) in strata/.env
 *
 * Wall time: 30–60 min per run, Gemini-quota-bound.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface OracleEntry {
  question_id: string;
  question_type: string;
}

function loadKuIds(): string[] {
  const oraclePath = join(__dirname, "../../benchmarks/longmemeval/data/longmemeval_oracle.json");
  const oracle: OracleEntry[] = JSON.parse(readFileSync(oraclePath, "utf-8"));
  return oracle
    .filter((q) => q.question_type === "knowledge-update")
    .map((q) => q.question_id);
}

function main() {
  const mode = process.env.STRATA_KU_FUSION_MODE ?? "off";
  if (!["off", "append", "rrf"].includes(mode)) {
    console.error(`STRATA_KU_FUSION_MODE must be off|append|rrf (got: ${mode})`);
    process.exit(2);
  }

  let ids = loadKuIds();

  // Smoke-test override: slice to a specific set of IDs without modifying the oracle.
  // Has no effect when unset; real runs (Tasks 8-10) leave it unset and read all 78 IDs.
  const smokeIds = process.env.STRATA_KU_FUSION_SMOKE_IDS;
  if (smokeIds) {
    const overrideIds = smokeIds.split(",").map((s) => s.trim()).filter(Boolean);
    console.log(`[smoke] Overriding to ${overrideIds.length} IDs via STRATA_KU_FUSION_SMOKE_IDS`);
    ids = overrideIds;
  } else {
    console.log(`KU fusion eval — mode=${mode}, ${ids.length} questions`);
    if (ids.length !== 78) {
      console.error(`Expected 78 KU questions, got ${ids.length}. Aborting.`);
      process.exit(2);
    }
  }

  const idsCsv = ids.join(",");
  // Run the benchmark in full answer mode (no --retrieval-only) with the slice.
  // Mode is already in process.env so it propagates to the spawned process.
  const cmd = [
    "npx", "tsx", "benchmarks/longmemeval/run-benchmark.ts",
    "--topK=20",
    "--prompt=category",
    `--ids=${idsCsv}`,
  ].join(" ");

  console.log(`\nRunning: ${cmd}\n`);
  execSync(cmd, {
    stdio: "inherit",
    env: {
      ...process.env,
      STRATA_KU_FUSION_MODE: mode,
      // Use gemini-2.5-flash as the answer model (spec §6.3) unless overridden.
      // Matches the 2026-03-27 500Q baseline model selection.
      LONGMEMEVAL_ANSWER_MODEL: process.env.LONGMEMEVAL_ANSWER_MODEL ?? "gemini-2.5-flash",
    },
    cwd: join(__dirname, "../.."),
    shell: process.platform === "win32" ? "cmd.exe" : true,
  });

  // Find the newest results file the benchmark wrote (pure Node.js — cross-platform).
  const resultsDir = join(__dirname, "../../benchmarks/longmemeval/data");
  const allResultFiles = readdirSync(resultsDir)
    .filter((f) => f.startsWith("results-") && f.endsWith(".json"))
    .map((f) => ({ name: f, mtime: statSync(join(resultsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (allResultFiles.length === 0) {
    console.error("No results file produced.");
    process.exit(1);
  }

  const newestPath = join(resultsDir, allResultFiles[0].name);
  const result = JSON.parse(readFileSync(newestPath, "utf-8"));

  // Normalize: handle both {accuracy: {byAbility: [...]}} and {byAbility: [...]} shapes
  const byAbility: Array<{ ability: string; correct: number; total: number; accuracy: number }> =
    result.accuracy?.byAbility ?? result.byAbility ?? [];

  const ku = byAbility.find((a) => a.ability === "knowledge_update");
  if (!ku) {
    console.error(`No knowledge_update slice found in ${allResultFiles[0].name}`);
    console.error("byAbility keys:", byAbility.map((a) => a.ability));
    process.exit(1);
  }

  // accuracy field is 0–100 (integer) in the results file format
  const accuracyPct = ku.accuracy <= 1 ? ku.accuracy * 100 : ku.accuracy;
  console.log(`\n=== KU fusion eval result (mode=${mode}) ===`);
  console.log(`  Slice: ${ku.correct}/${ku.total}  =  ${accuracyPct.toFixed(2)}%`);
  console.log(`  Result file: ${newestPath}`);

  // Write a summary stub the experiment ledger can be filled in from.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stubPath = join(__dirname, `experiments/run-${mode}-${timestamp}.md`);
  const pct = accuracyPct.toFixed(2);
  writeFileSync(
    stubPath,
    `# KU fusion run — mode=${mode}\n\nAccuracy: ${ku.correct}/${ku.total} = ${pct}%\n\nResult file: \`${newestPath}\`\n\nDate: ${new Date().toISOString()}\n`,
  );
  console.log(`  Stub written to: ${stubPath}\n`);
}

main();
