// strata/autoresearch/ssa-dense-turn-lane/run-eval.ts
/**
 * AutoResearch eval: dense turn-lane — single-session-assistant (SSA) answer accuracy.
 *
 * FROZEN. Arm A (lift): run the full LongMemEval-S set with the dense turn-lane
 * ON vs OFF and compare the SSA slice (computed from perQuestion, NOT byAbility,
 * because 3 question types share the information_extraction ability). Arm B
 * (non-regression): compare every other ability's accuracy ON vs OFF.
 *
 * A single env flips the whole lane:
 *   STRATA_DENSE_TURN_LANE=off  npx tsx autoresearch/ssa-dense-turn-lane/run-eval.ts
 *   STRATA_DENSE_TURN_LANE=on   npx tsx autoresearch/ssa-dense-turn-lane/run-eval.ts
 *
 * Resumable: always spawns run-benchmark.ts with --run-id (this machine drops
 * internet ~every 30 min; a drop mid-run resumes instead of restarting).
 * Smoke (quota-free-ish, few questions): STRATA_SSA_SMOKE_IDS="id1,id2" ...
 *
 * Requires: GEMINI_API_KEY (answer) + OPENAI_API_KEY (judge) in strata/.env.
 * Wall time: ~60 min/arm full (500Q); use run-canary.ts for N>=3.
 *
 * Spec: 2026-06-02-dense-turn-lane-design §8.3
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "../..");
const DATA_DIR = join(REPO, "benchmarks/longmemeval/data");

interface PerQuestion { questionType?: string; judgeVerdict?: string; }
interface AbilityScore { ability: string; correct: number; total: number; accuracy: number; }

function main(): void {
  const mode = process.env.STRATA_DENSE_TURN_LANE ?? "off";
  if (!["off", "on"].includes(mode)) {
    console.error(`STRATA_DENSE_TURN_LANE must be off|on (got: ${mode})`);
    process.exit(2);
  }

  const cmd: string[] = [
    "npx", "tsx", "benchmarks/longmemeval/run-benchmark.ts",
    "--top-k=20",
    "--prompt=category",
    "--session-scoring",
    "--reranker=onnx",
    "--events",
    "--judge-votes=3",
    `--run-id=ssa-dtl-${mode}`,
  ];
  const smoke = process.env.STRATA_SSA_SMOKE_IDS;
  if (smoke) cmd.push(`--ids=${smoke}`);

  console.log(`\nDense turn-lane SSA eval — mode=${mode}\nRunning: ${cmd.join(" ")}\n`);
  execSync(cmd.join(" "), {
    stdio: "inherit",
    cwd: REPO,
    env: {
      ...process.env,
      STRATA_DENSE_TURN_LANE: mode,
      LONGMEMEVAL_ANSWER_MODEL: process.env.LONGMEMEVAL_ANSWER_MODEL ?? "vertex:gemini-2.5-flash",
    },
    shell: process.platform === "win32" ? "cmd.exe" : (true as unknown as string),
  });

  const newest = readdirSync(DATA_DIR)
    .filter((f) => f.startsWith("results-") && f.endsWith(".json"))
    .map((f) => ({ f, mtime: statSync(join(DATA_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  if (!newest) { console.error("No results file produced."); process.exit(1); }
  const resultPath = join(DATA_DIR, newest.f);
  const result = JSON.parse(readFileSync(resultPath, "utf-8"));

  // Arm A — SSA slice from perQuestion (NOT byAbility).
  const pq: PerQuestion[] = result.perQuestion ?? [];
  const ssa = pq.filter((q) => q.questionType === "single-session-assistant");
  const ssaCorrect = ssa.filter((q) => q.judgeVerdict === "CORRECT").length;
  const ssaAcc = ssa.length > 0 ? (ssaCorrect / ssa.length) * 100 : 0;

  // Arm B — per-ability table (non-regression).
  const byAbility: AbilityScore[] = result.accuracy?.byAbility ?? result.byAbility ?? [];

  console.log(`\n=== Dense turn-lane SSA eval (mode=${mode}) ===`);
  console.log(`  Arm A — SSA slice: ${ssaCorrect}/${ssa.length} = ${ssaAcc.toFixed(2)}%`);
  console.log(`  Arm B — per-ability (non-regression):`);
  for (const a of byAbility) {
    const pct = a.accuracy <= 1 ? a.accuracy * 100 : a.accuracy;
    console.log(`    ${a.ability.padEnd(24)} ${a.correct}/${a.total} = ${pct.toFixed(2)}%`);
  }
  console.log(`  Result file: ${resultPath}`);

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const stub = join(__dirname, `experiments/run-${mode}-${ts}.md`);
  writeFileSync(
    stub,
    `# Dense turn-lane run — mode=${mode}\n\n` +
    `Arm A (SSA): ${ssaCorrect}/${ssa.length} = ${ssaAcc.toFixed(2)}%\n\n` +
    `Arm B (byAbility):\n` +
    byAbility.map((a) => `- ${a.ability}: ${a.correct}/${a.total} = ${(a.accuracy <= 1 ? a.accuracy * 100 : a.accuracy).toFixed(2)}%`).join("\n") +
    `\n\nResult file: \`${resultPath}\`\nDate: ${new Date().toISOString()}\n`,
  );
  console.log(`  Stub: ${stub}\n`);
}

main();
