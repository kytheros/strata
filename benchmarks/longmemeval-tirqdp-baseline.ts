/**
 * LongMemEval TIR+QDP Baseline Benchmark
 *
 * Stage 1: script exists, type-checks, is runnable. DO NOT run this in Stage 1 —
 * it costs $30-50 in OpenAI calls and 60 min wall time. That's Stage 2.
 *
 * Measures task-averaged accuracy of Strata's search pipeline with and without
 * TIR+QDP enabled, so we can quantify the retrieval improvement.
 *
 * Usage (Stage 2 only):
 *   npx tsx benchmarks/longmemeval-tirqdp-baseline.ts --flag on  --qset 50
 *   npx tsx benchmarks/longmemeval-tirqdp-baseline.ts --flag off --qset 50
 *   npx tsx benchmarks/longmemeval-tirqdp-baseline.ts --flag on  --qset 500
 *   npx tsx benchmarks/longmemeval-tirqdp-baseline.ts --flag on  --qset 500 --dry-run
 *
 * Flags:
 *   --flag on|off              Sets CONFIG.search.useTirQdp (required)
 *   --qset N                   Number of questions to run (50 | 500, default: 50)
 *   --qset-strategy first|stratified
 *                              "first" (default): take questions[0..N) — fast iteration,
 *                                may bias toward one ability category.
 *                              "stratified": proportional sample across all 5 abilities
 *                                — better directional signal for delta measurement.
 *   --answer-model <name>      Model for answer generation. Default: gpt-4o-2024-08-06
 *                              (matches feedback_longmemeval_gpt4o.md project convention
 *                              for comparability with published baselines). Examples:
 *                              gpt-4o, gpt-4o-mini, claude-sonnet-4-6, gemini-2.5-flash.
 *   --dry-run                  Exercise code paths but skip all LLM calls (free)
 *   --skip N                   Skip the first N questions (resume after crash)
 *   --top-k N                  Search results per question (default: 20)
 *
 * Environment:
 *   OPENAI_API_KEY      GPT-4o answer + judge (default per project convention)
 *   ANTHROPIC_API_KEY   Claude answer model (only used when --answer-model overrides)
 *   GEMINI_API_KEY      Embeddings + fallback answer model
 *
 * Caching:
 *   LLM extractions are cached in benchmarks/longmemeval/data/extraction-cache/
 *   per feedback_cache_expensive_operations.md — re-runs reuse existing cache entries.
 *
 * Results:
 *   Written to benchmarks/longmemeval/results/tirqdp-baseline-{flag}-{qset}-{timestamp}.json
 *
 * Spec: 2026-05-01-tirqdp-community-port-plan.md §TIRQDP-2.2
 * Ticket: kytheros/strata#5
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { CONFIG } from "../src/config.js";
import { handleSearchHistory } from "../src/tools/search-history.js";
import type { SearchResult } from "../src/search/sqlite-search-engine.js";
import type {
  LongMemQuestion,
  AnswerResult,
  BenchmarkResults,
  MemoryAbility,
  AbilityScore,
} from "./longmemeval/types.js";
import { questionTypeToAbility } from "./longmemeval/types.js";
import type { MemoryAbility as AbilityName } from "./longmemeval/types.js";
import { ingestQuestion, closeIngested } from "./longmemeval/ingest.js";
import { generateAnswer, sleep, withRetry } from "./longmemeval/answer.js";
import { judgeAnswer } from "./longmemeval/judge.js";
import { createAnswerProvider, createJudgeProvider } from "./longmemeval/providers/provider-factory.js";

// ---------------------------------------------------------------------------
// Module path
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "longmemeval", "data");
const RESULTS_DIR = join(__dirname, "longmemeval", "results");

// ---------------------------------------------------------------------------
// .env loader (mirrors run-benchmark.ts pattern)
// ---------------------------------------------------------------------------

function loadEnv(): void {
  try {
    const envPath = join(__dirname, "../.env");
    const envContent = readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const match = line.match(/^(\w+)=(.+)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].trim();
      }
    }
  } catch {
    // .env not found — rely on env vars
  }
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface BenchmarkArgs {
  /** TIR+QDP flag: "on" sets useTirQdp=true, "off" sets false */
  flag: "on" | "off";
  /** Number of questions to run (50 or 500) */
  qset: number;
  /**
   * Subset selection strategy.
   *   "first"      — questions.slice(0, qset). Back-compat default. Fast,
   *                  but may concentrate in a single ability category.
   *   "stratified" — proportional sample across all 5 LongMemEval abilities.
   *                  Preferred for directional delta measurement.
   */
  qsetStrategy: "first" | "stratified";
  /**
   * Model name for answer generation. Defaults to gpt-4o-2024-08-06 per
   * feedback_longmemeval_gpt4o.md — keeps published-baseline comparability.
   * Pass through to LONGMEMEVAL_ANSWER_MODEL env var before provider creation.
   */
  answerModel: string;
  /** Dry-run: skip all LLM calls, return dummy answers/verdicts */
  dryRun: boolean;
  /** Skip the first N questions (for resuming crashed runs) */
  skip: number;
  /** Search results per question */
  topK: number;
  /**
   * Verify that the flag path actually changes result composition.
   * Runs the first question twice (flag on, flag off) and asserts that:
   *   - flag=on produces at least one source:"turn" result
   *   - flag=off produces zero source:"turn" results
   * Exits 0 on success, 1 on failure. No LLM calls; implies --dry-run.
   */
  verifyFlagPath: boolean;
}

function parseArgs(): BenchmarkArgs {
  const argv = process.argv.slice(2);

  const flagArg = argv.find(a => a === "--flag");
  const flagIdx = flagArg !== undefined ? argv.indexOf("--flag") : -1;
  const flagVal = flagIdx >= 0 ? argv[flagIdx + 1] : undefined;
  if (!flagVal || (flagVal !== "on" && flagVal !== "off")) {
    console.error("Usage: npx tsx benchmarks/longmemeval-tirqdp-baseline.ts --flag on|off [--qset 50|500] [--dry-run]");
    process.exit(1);
  }

  const qsetArg = argv.find(a => a.startsWith("--qset="));
  const qsetVal = qsetArg ? parseInt(qsetArg.split("=")[1], 10) : undefined;
  // Also support --qset 50 (space form)
  const qsetIdx = argv.indexOf("--qset");
  const qsetSpaceVal = qsetIdx >= 0 && !qsetArg ? parseInt(argv[qsetIdx + 1], 10) : undefined;
  const qset = qsetVal ?? qsetSpaceVal ?? 50;

  const dryRun = argv.includes("--dry-run");
  const verifyFlagPath = argv.includes("--verify-flag-path");

  const skipArg = argv.find(a => a.startsWith("--skip="));
  const skip = skipArg ? parseInt(skipArg.split("=")[1], 10) : 0;

  const topKArg = argv.find(a => a.startsWith("--top-k="));
  const topK = topKArg ? parseInt(topKArg.split("=")[1], 10) : 20;

  // --qset-strategy first|stratified  (default: first, back-compat)
  const qsetStrategyEqArg = argv.find(a => a.startsWith("--qset-strategy="));
  const qsetStrategyIdx = argv.indexOf("--qset-strategy");
  const qsetStrategyRaw = qsetStrategyEqArg
    ? qsetStrategyEqArg.split("=")[1]
    : qsetStrategyIdx >= 0
      ? argv[qsetStrategyIdx + 1]
      : "first";
  if (qsetStrategyRaw !== "first" && qsetStrategyRaw !== "stratified") {
    console.error(`Invalid --qset-strategy: ${qsetStrategyRaw}. Use "first" or "stratified".`);
    process.exit(1);
  }
  const qsetStrategy = qsetStrategyRaw as "first" | "stratified";

  // --answer-model <name>  (default: gpt-4o-2024-08-06 per feedback_longmemeval_gpt4o.md)
  const answerModelEqArg = argv.find(a => a.startsWith("--answer-model="));
  const answerModelIdx = argv.indexOf("--answer-model");
  const answerModel = answerModelEqArg
    ? answerModelEqArg.split("=")[1]
    : answerModelIdx >= 0
      ? argv[answerModelIdx + 1]
      : "gpt-4o-2024-08-06";

  return { flag: flagVal as "on" | "off", qset, qsetStrategy, answerModel, dryRun, skip, topK, verifyFlagPath };
}

// ---------------------------------------------------------------------------
// Question subset selection
// ---------------------------------------------------------------------------

/**
 * Select a subset of questions from the dataset.
 *
 * Strategies:
 *   "first"      — questions.slice(0, qset). Back-compat. Fast but may
 *                  bias toward one ability if the dataset is ordered.
 *   "stratified" — proportional round-robin across all 5 abilities. Better
 *                  for delta measurement; the actual sample size may be
 *                  slightly under `qset` if a bucket runs dry.
 */
function selectQuestions(
  questions: LongMemQuestion[],
  qset: number,
  strategy: "first" | "stratified" = "first"
): LongMemQuestion[] {
  if (qset >= questions.length) return questions;
  if (strategy === "first") return questions.slice(0, qset);
  return stratifiedSelect(questions, qset);
}

function stratifiedSelect(questions: LongMemQuestion[], qset: number): LongMemQuestion[] {
  const abilities: AbilityName[] = [
    "information_extraction",
    "multi_session_reasoning",
    "temporal_reasoning",
    "knowledge_update",
    "abstention",
  ];

  // Partition the full pool by ability — keep dataset ordering within each bucket
  // so re-runs are deterministic without a seed.
  const buckets = new Map<AbilityName, LongMemQuestion[]>();
  for (const ab of abilities) buckets.set(ab, []);
  for (const q of questions) {
    const ab = questionTypeToAbility(q.question_type);
    buckets.get(ab)!.push(q);
  }

  // Target: qset / 5 per bucket, with leftover distributed to the first buckets.
  const perBucket = Math.floor(qset / abilities.length);
  const remainder = qset % abilities.length;

  const result: LongMemQuestion[] = [];
  abilities.forEach((ab, i) => {
    const bucket = buckets.get(ab)!;
    const target = perBucket + (i < remainder ? 1 : 0);
    const take = Math.min(target, bucket.length);
    if (take < target) {
      console.warn(
        `[qset stratified] Ability "${ab}" has only ${bucket.length} questions, wanted ${target}. ` +
        `Final sample size will be smaller than requested qset.`
      );
    }
    result.push(...bucket.slice(0, take));
  });

  return result;
}

// ---------------------------------------------------------------------------
// Search wrapper — uses handleSearchHistory so the flag is actually exercised
// ---------------------------------------------------------------------------

/**
 * Run a search against the ingested question's DB via handleSearchHistory.
 * This is the only path that reads CONFIG.search.useTirQdp, so it's required
 * for the benchmark to produce a real delta between --flag on and --flag off.
 *
 * Returns a SearchResult-compatible array for use with generateAnswer().
 * The "detailed" format produces a JSON array; we parse it back into objects.
 */
async function searchIngested(
  ingested: Awaited<ReturnType<typeof ingestQuestion>>,
  query: string,
  topK: number
): Promise<SearchResult[]> {
  const raw = await handleSearchHistory(
    ingested.searchEngine,
    {
      query,
      limit: topK,
      format: "detailed",
      project: "longmemeval",
    },
    ingested.db,
    undefined,           // no asyncSearch — use FTS5 directly
    ingested.knowledgeStore,
    ingested.turnStore,
  );

  // "detailed" format returns a JSON array wrapped in CompactSerializer output.
  // The CompactSerializer detailed format is: JSON array of record objects.
  try {
    // Try to extract JSON array from the response (may have a leading label line)
    const jsonStart = raw.indexOf("[");
    if (jsonStart === -1) return [];
    const parsed = JSON.parse(raw.slice(jsonStart)) as Array<{
      sessionId: string;
      project: string;
      text: string;
      score: number;
      confidence: number;
      date: string;
      source?: string;
    }>;

    return parsed.map(r => ({
      sessionId: r.sessionId ?? "",
      project: r.project ?? "longmemeval",
      text: r.text ?? "",
      score: r.score ?? 0,
      confidence: r.confidence ?? 0,
      timestamp: r.date ? new Date(r.date).getTime() || 0 : 0,
      toolNames: [],
      role: "mixed" as const,
      source: r.source as SearchResult["source"],
    }));
  } catch {
    // If parsing fails, fall back to the engine directly (no flag effect, but safe)
    return ingested.searchEngine.search(query, { limit: topK });
  }
}

/** Count how many results carry source: "turn" in a search result set. */
function countTurnResults(results: SearchResult[]): number {
  return results.filter(r => r.source === "turn").length;
}

// ---------------------------------------------------------------------------
// --verify-flag-path mode
// ---------------------------------------------------------------------------

/**
 * Self-check mode: ingest the first question, run the search twice (flag on
 * and flag off), and assert the result compositions differ as expected.
 *
 * Exits 0 on success, 1 on failure. No LLM calls.
 */
async function runVerifyFlagPath(questions: LongMemQuestion[], topK: number): Promise<void> {
  console.log("=== --verify-flag-path mode ===");
  console.log("Ingesting first question...");

  const question = questions[0];
  const ingested = await ingestQuestion(question);

  try {
    const turnCount = await ingested.turnStore.count();
    console.log(`Turn store: ${turnCount} rows (expect ≥1)`);
    if (turnCount === 0) {
      console.error("FAIL: turn store is empty after ingest — turns are not being indexed");
      process.exit(1);
    }

    // Run with flag ON
    CONFIG.search.useTirQdp = true;
    const onResults = await searchIngested(ingested, question.question, topK);
    const onTurnCount = countTurnResults(onResults);

    // Run with flag OFF
    CONFIG.search.useTirQdp = false;
    const offResults = await searchIngested(ingested, question.question, topK);
    const offTurnCount = countTurnResults(offResults);

    console.log(`\nflag=on:  ${onResults.length} results, ${onTurnCount} with source:"turn"`);
    console.log(`flag=off: ${offResults.length} results, ${offTurnCount} with source:"turn"`);

    if (onTurnCount === 0) {
      console.error("FAIL: flag=on produced 0 turn results — TIR+QDP lane not reached");
      process.exit(1);
    }
    if (offTurnCount > 0) {
      console.error("FAIL: flag=off produced turn results — legacy path is leaking");
      process.exit(1);
    }

    console.log("\nPASS: flag=on and flag=off produce different result compositions.");
    console.log("Stage 2 is safe to run.");
  } finally {
    closeIngested(ingested);
  }
}

// ---------------------------------------------------------------------------
// Per-ability accuracy scoring
// ---------------------------------------------------------------------------

function computeAbilityScores(results: AnswerResult[]): AbilityScore[] {
  const abilities: MemoryAbility[] = [
    "information_extraction",
    "multi_session_reasoning",
    "temporal_reasoning",
    "knowledge_update",
    "abstention",
  ];

  return abilities.map(ability => {
    const subset = results.filter(r => r.ability === ability);
    const correct = subset.filter(r => r.judgeVerdict === "CORRECT").length;
    return {
      ability,
      correct,
      total: subset.length,
      accuracy: subset.length > 0 ? correct / subset.length : 0,
    };
  });
}

/**
 * Task-averaged accuracy: mean of per-ability accuracies (not raw count).
 * This matches the official LongMemEval paper metric.
 */
function taskAveragedAccuracy(abilityScores: AbilityScore[]): number {
  const withData = abilityScores.filter(s => s.total > 0);
  if (withData.length === 0) return 0;
  return withData.reduce((sum, s) => sum + s.accuracy, 0) / withData.length;
}

// ---------------------------------------------------------------------------
// Dry-run stubs
// ---------------------------------------------------------------------------

/**
 * Dry-run answer: immediately returns a placeholder without LLM calls.
 * Exercises the code path without spending tokens.
 */
async function dryRunAnswer(): Promise<{ answer: string; latencyMs: number }> {
  return { answer: "[DRY-RUN: no LLM call]", latencyMs: 0 };
}

/**
 * Dry-run judge: returns a deterministic INCORRECT verdict (conservative).
 */
async function dryRunJudge(): Promise<{
  verdict: "CORRECT" | "INCORRECT";
  rawResponse: string;
  latencyMs: number;
}> {
  return { verdict: "INCORRECT", rawResponse: "[DRY-RUN]", latencyMs: 0 };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnv();

  const args = parseArgs();

  // Apply the feature flag to CONFIG before any search calls.
  // This is safe because benchmarks are single-process and run sequentially.
  CONFIG.search.useTirQdp = args.flag === "on";

  // Force the provider factory to use the chosen answer model. Unconditional
  // override — args.answerModel always has a value (defaulted in parseArgs).
  // Required because the factory's auto-detect picks Claude when ANTHROPIC_API_KEY
  // is present, which silently breaks comparability with the GPT-4o published baseline.
  process.env.LONGMEMEVAL_ANSWER_MODEL = args.answerModel;

  console.log("LongMemEval TIR+QDP Baseline Benchmark");
  console.log("=======================================");
  console.log(`Flag:           useTirQdp = ${CONFIG.search.useTirQdp}`);
  console.log(`Q-set:          ${args.qset} questions (${args.qsetStrategy})`);
  console.log(`Answer model:   ${args.answerModel}`);
  console.log(`Dry-run:        ${args.dryRun}`);
  console.log(`Top-K:          ${args.topK}`);
  if (args.skip > 0) console.log(`Skip:           ${args.skip} questions`);
  console.log();

  // Validate dataset exists
  const dataFile = join(DATA_DIR, "longmemeval_s_cleaned.json");
  if (!existsSync(dataFile)) {
    console.error(`Dataset not found at ${dataFile}`);
    console.error("Run: npx tsx benchmarks/longmemeval/download-dataset.ts");
    process.exit(1);
  }

  const allQuestions = JSON.parse(readFileSync(dataFile, "utf-8")) as LongMemQuestion[];
  const questions = selectQuestions(allQuestions, args.qset, args.qsetStrategy).slice(args.skip);

  console.log(`Loaded ${allQuestions.length} total questions, running ${questions.length}`);
  console.log();

  // --verify-flag-path: self-check mode — runs before API key validation
  if (args.verifyFlagPath) {
    await runVerifyFlagPath(questions, args.topK);
    process.exit(0);
  }

  // Require API keys for non-dry-run mode.
  // Per feedback_longmemeval_gpt4o.md: GPT-4o judge is required for comparable scores.
  if (!args.dryRun) {
    if (!process.env.OPENAI_API_KEY) {
      console.error("OPENAI_API_KEY required for GPT-4o judge (non-dry-run mode).");
      console.error("See feedback_longmemeval_gpt4o.md — all benchmark runs must use GPT-4o judge.");
      process.exit(1);
    }
  }

  // Create providers (skipped in dry-run since we never call them)
  const answerProvider = args.dryRun ? null : createAnswerProvider().provider;
  const judgeProvider = args.dryRun ? null : createJudgeProvider().provider;
  const answerModelName = args.dryRun ? "dry-run" : createAnswerProvider().modelName;
  const judgeModelName = args.dryRun ? "dry-run" : createJudgeProvider().modelName;

  console.log(`Answer model: ${answerModelName}`);
  console.log(`Judge model:  ${judgeModelName}`);
  console.log();

  const answerResults: AnswerResult[] = [];

  for (let i = 0; i < questions.length; i++) {
    const question = questions[i];
    const globalIdx = i + args.skip;
    const progress = `[${globalIdx + 1}/${args.qset}]`;
    process.stdout.write(`${progress} Q${question.question_id} (${question.question_type})`);

    // Ingest the question's haystack sessions into a fresh in-memory SQLite DB.
    // Caching of LLM extraction results (if used) happens inside pro-pipeline.ts.
    const ingested = await ingestQuestion(question);

    // Retrieve context via handleSearchHistory — the same MCP tool path real
    // clients use. This is the only call that reads CONFIG.search.useTirQdp,
    // so flag=on vs flag=off produce different result compositions here.
    const searchResults = await searchIngested(ingested, question.question, args.topK);

    // Answer generation
    const answerResult = args.dryRun || !answerProvider
      ? await dryRunAnswer()
      : await withRetry(() =>
          generateAnswer(answerProvider, question.question, question.question_date, searchResults, {
            topK: args.topK,
            promptVariant: "chain-of-note",
            questionType: question.question_type,
          })
        );

    await sleep(args.dryRun ? 0 : 300);

    // Judge
    const judgeResult = args.dryRun || !judgeProvider
      ? await dryRunJudge()
      : await withRetry(() =>
          judgeAnswer(
            judgeProvider,
            question.question_type,
            question.question_id,
            question.question,
            question.answer,
            answerResult.answer
          )
        );

    await sleep(args.dryRun ? 0 : 200);

    const ability = questionTypeToAbility(question.question_type);
    answerResults.push({
      questionId: question.question_id,
      questionType: question.question_type,
      ability,
      question: question.question,
      goldAnswer: question.answer,
      predictedAnswer: answerResult.answer,
      judgeVerdict: judgeResult.verdict,
      judgeRawResponse: judgeResult.rawResponse,
      answerModel: answerModelName,
      judgeModel: judgeModelName,
      answerLatencyMs: answerResult.latencyMs,
      judgeLatencyMs: judgeResult.latencyMs,
    });

    const verdictSymbol = judgeResult.verdict === "CORRECT" ? "✓" : "✗";
    process.stdout.write(` ${verdictSymbol}\n`);

    closeIngested(ingested);
  }

  // ---------------------------------------------------------------------------
  // Scoring
  // ---------------------------------------------------------------------------

  const rawCorrect = answerResults.filter(r => r.judgeVerdict === "CORRECT").length;
  const rawAccuracy = rawCorrect / answerResults.length;
  const abilityScores = computeAbilityScores(answerResults);
  const taskAvg = taskAveragedAccuracy(abilityScores);

  console.log("\n" + "=".repeat(60));
  console.log("Results");
  console.log("=".repeat(60));
  console.log(`\nuseTirQdp:       ${CONFIG.search.useTirQdp}`);
  console.log(`Questions run:   ${answerResults.length}`);
  console.log(`Raw accuracy:    ${(rawAccuracy * 100).toFixed(1)}% (${rawCorrect}/${answerResults.length})`);
  console.log(`Task-averaged:   ${(taskAvg * 100).toFixed(1)}%`);
  console.log(`Answer model:    ${answerModelName}`);
  console.log(`Judge model:     ${judgeModelName}`);

  console.log("\nPer-Ability Breakdown:");
  console.log("| Ability                 | Accuracy | N    |");
  console.log("|-------------------------|----------|------|");
  for (const s of abilityScores) {
    const label = s.ability.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    if (s.total > 0) {
      console.log(`| ${label.padEnd(23)} | ${(s.accuracy * 100).toFixed(1).padStart(5)}%   | ${String(s.total).padStart(4)} |`);
    }
  }

  // ---------------------------------------------------------------------------
  // Write result file
  // ---------------------------------------------------------------------------

  mkdirSync(RESULTS_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const resultFileName = `tirqdp-baseline-${args.flag}-${args.qset}-${timestamp}.json`;
  const resultPath = join(RESULTS_DIR, resultFileName);

  const output: Omit<BenchmarkResults, "retrieval"> & {
    tirqdpFlag: boolean;
    tirqdpFlagArg: string;
    accuracy: BenchmarkResults["accuracy"];
    models: BenchmarkResults["models"];
  } = {
    variant: "s",
    searchMode: CONFIG.search.useTirQdp ? "hybrid" : "bm25",
    timestamp: new Date().toISOString(),
    numQuestions: answerResults.length,
    tirqdpFlag: CONFIG.search.useTirQdp,
    tirqdpFlagArg: args.flag,
    accuracy: {
      raw: rawAccuracy,
      rawCount: rawCorrect,
      taskAveraged: taskAvg,
      byAbility: abilityScores,
    },
    models: {
      answerModel: answerModelName,
      judgeModel: judgeModelName,
    },
    perQuestion: answerResults as any,
  };

  writeFileSync(resultPath, JSON.stringify(output, null, 2));
  console.log(`\nResults saved: ${resultPath}`);

  if (args.dryRun) {
    console.log("\n[DRY-RUN] All LLM calls were skipped. Scores are 0% (expected).");
    console.log("Remove --dry-run for a real run (costs ~$30-50 OpenAI + ~60 min).");
  }
}

main().catch(err => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
