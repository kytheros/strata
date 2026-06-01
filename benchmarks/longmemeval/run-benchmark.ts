/**
 * LongMemEval Benchmark — Main Orchestrator
 *
 * Runs the full LongMemEval benchmark against Strata's search engine:
 *   1. Load dataset from data/
 *   2. For each question: ingest haystack → search → score retrieval
 *   3. Optionally: generate answers → judge → score accuracy
 *   4. Output results as markdown table + JSON
 *
 * Usage:
 *   npx tsx benchmarks/longmemeval/run-benchmark.ts
 *   npx tsx benchmarks/longmemeval/run-benchmark.ts --retrieval-only
 *   npx tsx benchmarks/longmemeval/run-benchmark.ts --limit=5
 *   npx tsx benchmarks/longmemeval/run-benchmark.ts --variant=m
 *   npx tsx benchmarks/longmemeval/run-benchmark.ts --prompt=enhanced --top-k=5
 *   npx tsx benchmarks/longmemeval/run-benchmark.ts --pro --knowledge-limit=10
 *
 * Environment variables:
 *   OPENAI_API_KEY              — For GPT-4o judge (recommended for comparable scores)
 *   ANTHROPIC_API_KEY           — For Claude Sonnet 4 (answer generation)
 *   GEMINI_API_KEY              — For Gemini 2.5 Flash (fallback)
 *   LONGMEMEVAL_ANSWER_MODEL    — Override answer model
 *   LONGMEMEVAL_JUDGE_MODEL     — Override judge model
 *
 * API keys can be set in strata/.env or as environment variables.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { appendResult, loadCompleted } from "./checkpoint.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type {
  LongMemQuestion,
  RetrievalResult,
  AnswerResult,
  BenchmarkResults,
  MemoryAbility,
  AbilityScore,
} from "./types.js";
import { questionTypeToAbility } from "./types.js";
import { ingestQuestion, closeIngested, configureEmbeddingCache, getEmbeddingCacheStats } from "./ingest.js";
import { retrieveQuestion, aggregateRetrieval } from "./retrieve.js";
import { generateAnswer, generateAnswerTwoPass, isCountingQuestion, isDurationQuestion, sleep, withRetry } from "./answer.js";
import type { PromptVariant } from "./answer.js";
import type { AgentLoopResult, CapturePair } from "./agent-loop.js";
import type { GeminiAgentLoopResult } from "./gemini-agent-loop.js";
import type DatabaseType from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { saveTrainingPair } from "../../src/extensions/llm-extraction/training-capture.js";
import type { PlannedSearchResult } from "./planned-search.js";
import { judgeAnswer } from "./judge.js";
import { createAnswerProvider, createJudgeProvider } from "./providers/provider-factory.js";
import { runProExtraction, searchKnowledge, formatKnowledgeForPrompt } from "./pro-pipeline.js";
import { isDecomposable, decomposedSearch } from "./query-decomposer.js";
import { loadCachedEvents, formatEventsForPrompt, filterEventsByRelevance } from "./extract-events.js";
import { expandQuery, filterByRelevance } from "./query-expansion.js";
import { summariseTokens, computeCost } from "./token-cost.js";
import type { TokenUsage } from "./token-cost.js";
import { answerWithGapCoverage } from "./gap-coverage.js";
import { judgeGap } from "./gap-judge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");

/**
 * Summarise a list of latencies (ms) into mean + p50 + p95 + p99.
 * Empty input returns all zeros.
 */
export function summariseLatency(latencies: number[]): {
  meanMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
} {
  if (latencies.length === 0) {
    return { meanMs: 0, p50LatencyMs: 0, p95LatencyMs: 0, p99LatencyMs: 0 };
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const mean = sorted.reduce((s, x) => s + x, 0) / sorted.length;
  const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return {
    meanMs: mean,
    p50LatencyMs: percentile(50),
    p95LatencyMs: percentile(95),
    p99LatencyMs: percentile(99),
  };
}

/** Embedding cache is on unless --no-embedding-cache or LONGMEMEVAL_NO_EMBED_CACHE=1. */
export function resolveEmbeddingCacheEnabled(
  args: string[],
  env: NodeJS.ProcessEnv
): boolean {
  if (args.includes("--no-embedding-cache")) return false;
  if (env.LONGMEMEVAL_NO_EMBED_CACHE === "1") return false;
  return true;
}

/**
 * Persist a buffer of CapturePairs to the training_data table.
 * Atomically writes all pairs with quality_score backfilled from the judge
 * verdict (1.0 for CORRECT, 0.0 for INCORRECT). Skips writing entirely when
 * the verdict is null or the buffer is empty.
 *
 * Individual write failures are logged via console.warn but never thrown —
 * capture must not affect the primary benchmark path.
 *
 * Spec: specs/2026-05-28-reasoning-trace-capture-design.md §7
 */
export function persistCaptureBuffer(
  db: DatabaseType.Database,
  buffer: CapturePair[],
  verdict: "CORRECT" | "INCORRECT" | null,
  modelUsed: string,
): void {
  if (verdict === null || buffer.length === 0) return;
  const qualityScore = verdict === "CORRECT" ? 1.0 : 0.0;

  for (const pair of buffer) {
    try {
      if (pair.kind === "reasoning_tool_call") {
        saveTrainingPair(db, {
          taskType: "reasoning_tool_call",
          inputText: JSON.stringify(pair.messages),
          outputJson: JSON.stringify(pair.toolCall),
          modelUsed,
          qualityScore,
          heuristicDiverged: false,
          reasoningTrace: pair.reasoning,
        });
      } else {
        saveTrainingPair(db, {
          taskType: "reasoning_final_answer",
          inputText: JSON.stringify(pair.messages),
          outputJson: JSON.stringify(pair.answer),
          modelUsed,
          qualityScore,
          heuristicDiverged: false,
          reasoningTrace: pair.reasoning,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[capture] saveTrainingPair failed for ${pair.kind}: ${msg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Load .env file (same pattern as autoresearch evals)
// ---------------------------------------------------------------------------

function loadEnv(): void {
  try {
    const envPath = join(__dirname, "../../.env");
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

export function parseArgs(): {
  variant: "s" | "m";
  retrievalOnly: boolean;
  limit: number;
  skip: number;
  topK: number;
  promptVariant: PromptVariant;
  thinkingBudget: number;
  filterIds: Set<string> | null;
  pro: boolean;
  knowledgeLimit: number;
  decompose: boolean;
  sessionScoring: boolean;
  reranker: "onnx" | "cohere" | "none";
  events: boolean;
  eventTopK: number;
  twoPass: boolean;
  agentLoop: boolean;
  maxIterations: number;
  plannedSearch: boolean;
  noVector: boolean;
  judgeVotes: number;
  stratifiedN: number;
  gapJudgeEnabled: boolean;
  gapCoverage: boolean;
  gapCoverageRounds: number;
  runId: string | null;
} {
  const args = process.argv.slice(2);

  const variantArg = args.find((a) => a.startsWith("--variant="));
  const variant = (variantArg?.split("=")[1] || "s") as "s" | "m";

  const retrievalOnly = args.includes("--retrieval-only");

  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : Infinity;

  const skipArg = args.find((a) => a.startsWith("--skip="));
  const skip = skipArg ? parseInt(skipArg.split("=")[1], 10) : 0;

  const topKArg = args.find((a) => a.startsWith("--top-k="));
  const topK = topKArg ? parseInt(topKArg.split("=")[1], 10) : 20;

  const promptArg = args.find((a) => a.startsWith("--prompt="));
  const promptVariant = (promptArg?.split("=")[1] || "chain-of-note") as PromptVariant;

  const thinkingArg = args.find((a) => a.startsWith("--thinking="));
  const thinkingBudget = thinkingArg ? parseInt(thinkingArg.split("=")[1], 10) : 0;

  const idsArg = args.find((a) => a.startsWith("--ids="));
  const filterIds = idsArg ? new Set(idsArg.split("=")[1].split(",")) : null;

  const pro = args.includes("--pro");
  const decompose = args.includes("--decompose");
  const sessionScoring = args.includes("--session-scoring");
  const events = args.includes("--events");

  const klArg = args.find((a) => a.startsWith("--knowledge-limit="));
  const knowledgeLimit = klArg ? parseInt(klArg.split("=")[1], 10) : 10;

  const rerankerArg = args.find((a) => a.startsWith("--reranker="));
  const reranker = (rerankerArg?.split("=")[1] || "none") as "onnx" | "cohere" | "none";

  const eventTopKArg = args.find((a) => a.startsWith("--event-top-k="));
  const eventTopK = eventTopKArg ? parseInt(eventTopKArg.split("=")[1], 10) : 10;

  const twoPass = args.includes("--two-pass");
  const agentLoop = args.includes("--agent-loop");
  const plannedSearch = args.includes("--planned-search");
  const noVector = args.includes("--no-vector");

  const maxIterationsArg = args.find((a) => a.startsWith("--max-iterations="));
  const maxIterations = maxIterationsArg ? parseInt(maxIterationsArg.split("=")[1], 10) : 8;

  // --judge-votes=N or LONGMEMEVAL_JUDGE_VOTES env. Default 1 (back-compat).
  let judgeVotes = 1;
  const judgeVotesFlag = args.find((a) => a.startsWith("--judge-votes="));
  if (judgeVotesFlag) {
    judgeVotes = parseInt(judgeVotesFlag.slice("--judge-votes=".length), 10);
  } else if (process.env.LONGMEMEVAL_JUDGE_VOTES) {
    judgeVotes = parseInt(process.env.LONGMEMEVAL_JUDGE_VOTES, 10);
  }
  if (!Number.isInteger(judgeVotes) || judgeVotes < 1) judgeVotes = 1;

  const stratArg = args.find((a) => a.startsWith("--stratified="));
  const stratifiedN = stratArg ? parseInt(stratArg.split("=")[1], 10) : 0;

  const gapJudgeEnabled = args.includes("--gap-judge");

  const gapCoverage = args.includes("--gap-coverage");
  const gapCoverageRoundsArg = args.find((a) => a.startsWith("--gap-coverage-rounds="));
  const gapCoverageRounds = gapCoverageRoundsArg
    ? parseInt(gapCoverageRoundsArg.split("=")[1], 10)
    : 1;

  // --run-id=<id>: enables per-question checkpointing and resume-on-restart.
  // When absent, runId is null and checkpoint calls are completely skipped
  // (flag-off is byte-identical to current behavior).
  const runIdArg = args.find((a) => a.startsWith("--run-id="));
  const runId: string | null = runIdArg ? runIdArg.slice("--run-id=".length) : null;

  return { variant, retrievalOnly, limit, skip, topK, promptVariant, thinkingBudget, filterIds, pro, knowledgeLimit, decompose, sessionScoring, reranker, events, eventTopK, twoPass, agentLoop, maxIterations, plannedSearch, noVector, judgeVotes, stratifiedN, gapJudgeEnabled, gapCoverage, gapCoverageRounds, runId };
}

// ---------------------------------------------------------------------------
// Dataset loading
// ---------------------------------------------------------------------------

function loadDataset(variant: "s" | "m"): LongMemQuestion[] {
  const filename =
    variant === "s"
      ? "longmemeval_s_cleaned.json"
      : "longmemeval_m_cleaned.json";
  const filePath = join(DATA_DIR, filename);

  if (!existsSync(filePath)) {
    console.error(`Dataset not found: ${filePath}`);
    console.error(`Run: npx tsx benchmarks/longmemeval/download-dataset.ts --variant=${variant}`);
    process.exit(1);
  }

  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as LongMemQuestion[];
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printRetrievalReport(
  results: RetrievalResult[],
  aggregate: ReturnType<typeof aggregateRetrieval>
): void {
  console.log("\nRetrieval Quality");
  console.log("| Metric             | Value  |");
  console.log("|--------------------|--------|");
  console.log(`| Evidence Recall@5  | ${aggregate.evidenceRecall5.toFixed(3)}  |`);
  console.log(`| Evidence Recall@10 | ${aggregate.evidenceRecall10.toFixed(3)}  |`);
  console.log(`| Evidence Recall@20 | ${aggregate.evidenceRecall20.toFixed(3)}  |`);
  console.log(`| MRR                | ${aggregate.mrr.toFixed(3)}  |`);
  console.log(`| p50 latency        | ${aggregate.p50LatencyMs.toFixed(0)}ms   |`);
  console.log(`| p95 latency        | ${aggregate.p95LatencyMs.toFixed(0)}ms   |`);

  // Spec 2026-05-25-unified-turn-lane-surface §3.3: surface turn-lane recall
  // as a diagnostic column. Undefined when the harness did not run the turn
  // lane (older result files); rendered only when at least one entry has a
  // non-undefined value.
  const turnRecallEntries = results
    .map(r => r.turnRecallAtK)
    .filter((v): v is number => typeof v === "number");
  if (turnRecallEntries.length > 0) {
    const avgTurnRecall =
      turnRecallEntries.reduce((s, v) => s + v, 0) / turnRecallEntries.length;
    console.log(`Turn-lane recall@K  (mean): ${(avgTurnRecall * 100).toFixed(2)}%  (${turnRecallEntries.length} questions)`);
  }
}

function printAccuracyReport(
  answerResults: AnswerResult[],
  answerModel: string,
  judgeModel: string
): void {
  // Group by ability
  const byAbility = new Map<MemoryAbility, { correct: number; total: number }>();
  for (const r of answerResults) {
    const entry = byAbility.get(r.ability) || { correct: 0, total: 0 };
    entry.total++;
    if (r.judgeVerdict === "CORRECT") entry.correct++;
    byAbility.set(r.ability, entry);
  }

  const abilityScores: AbilityScore[] = [];
  const abilityOrder: MemoryAbility[] = [
    "information_extraction",
    "multi_session_reasoning",
    "temporal_reasoning",
    "knowledge_update",
    "abstention",
  ];

  console.log(`\nAnswer Accuracy (answer: ${answerModel}, judge: ${judgeModel})`);
  console.log("| Question Type           | Correct | Total | Accuracy |");
  console.log("|-------------------------|---------|-------|----------|");

  for (const ability of abilityOrder) {
    const entry = byAbility.get(ability);
    if (!entry) continue;
    const accuracy = entry.total > 0 ? (entry.correct / entry.total) * 100 : 0;
    const label = ability.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    console.log(
      `| ${label.padEnd(23)} | ${String(entry.correct).padStart(7)} | ${String(entry.total).padStart(5)} | ${accuracy.toFixed(1).padStart(5)}%   |`
    );
    abilityScores.push({ ability, ...entry, accuracy });
  }

  // Task-averaged accuracy
  const taskAveraged =
    abilityScores.reduce((s, a) => s + a.accuracy, 0) / abilityScores.length;
  const totalCorrect = answerResults.filter(
    (r) => r.judgeVerdict === "CORRECT"
  ).length;
  const rawAccuracy = (totalCorrect / answerResults.length) * 100;

  console.log(
    `| ${"**Task-Averaged**".padEnd(23)} |         |       | **${taskAveraged.toFixed(1)}%** |`
  );
  console.log(
    `| ${"**Raw Accuracy**".padEnd(23)} | ${String(totalCorrect).padStart(7)} | ${String(answerResults.length).padStart(5)} | **${rawAccuracy.toFixed(1)}%** |`
  );

  // Latency block — end-to-end answer + judge timings. Strata is the second
  // memory system (after ByteRover) to publish these numbers prominently.
  const answerLats = answerResults
    .map((r) => r.answerLatencyMs)
    .filter((x) => Number.isFinite(x))
    .sort((a, b) => a - b);
  const judgeLats = answerResults
    .map((r) => r.judgeLatencyMs)
    .filter((x) => Number.isFinite(x))
    .sort((a, b) => a - b);
  const percentile = (xs: number[], p: number) =>
    xs.length === 0 ? 0 : xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
  const mean = (xs: number[]) =>
    xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
  console.log("\nLatency (end-to-end, ms)");
  console.log("|                | mean | p50  | p95  | p99  |");
  console.log("|----------------|------|------|------|------|");
  console.log(
    `| Answer model   | ${mean(answerLats).toFixed(0).padStart(4)} | ${percentile(answerLats, 50).toFixed(0).padStart(4)} | ${percentile(answerLats, 95).toFixed(0).padStart(4)} | ${percentile(answerLats, 99).toFixed(0).padStart(4)} |`
  );
  console.log(
    `| Judge          | ${mean(judgeLats).toFixed(0).padStart(4)} | ${percentile(judgeLats, 50).toFixed(0).padStart(4)} | ${percentile(judgeLats, 95).toFixed(0).padStart(4)} | ${percentile(judgeLats, 99).toFixed(0).padStart(4)} |`
  );

  // Published comparison
  console.log("\nPublished Comparison");
  console.log("| System    | Score  |");
  console.log("|-----------|--------|");
  console.log("| OMEGA     | 95.4%  |");
  console.log(`| **Strata**| **${taskAveraged.toFixed(1)}%**|`);
  console.log("| Hindsight | 91.4%  |");
  console.log("| Zep       | 71.2%  |");
  console.log("| Mem0      | ~66.9% |");
}

// ---------------------------------------------------------------------------
// Gap-coverage diagnostics summary
// ---------------------------------------------------------------------------

/**
 * Print gap-coverage diagnostics when --gap-coverage was active.
 * Shows: questions fired, new-chunk finds, re-answers superseded,
 * and (when the known 29 target IDs are available via companion JSON)
 * fixed vs regressed counts vs baselineResults.
 *
 * Target IDs (partial-coverage failures): loaded from
 * benchmarks/longmemeval/gap-coverage-targets.json if present.
 */
function printGapCoverageSummary(
  answerResults: AnswerResult[],
  baselineResults: Array<{ questionId: string; judgeVerdict: "CORRECT" | "INCORRECT" }> | null,
  targetIds: Set<string> | null
): void {
  const withGc = answerResults.filter(r => r.gapCoverageFired !== undefined);
  if (withGc.length === 0) return;

  const fired = withGc.filter(r => r.gapCoverageFired);
  const foundNew = fired.filter(r => (r.gapNewChunkCount ?? 0) > 0);
  const reAnswered = foundNew.length; // re-answer ran whenever new chunks found

  console.log("\nGap-Coverage Summary");
  console.log("| Metric                        | Count |");
  console.log("|-------------------------------|-------|");
  console.log(`| Questions checked             | ${withGc.length.toString().padStart(5)} |`);
  console.log(`| Gap-judge fired (insufficient)| ${fired.length.toString().padStart(5)} |`);
  console.log(`| Found new chunks              | ${foundNew.length.toString().padStart(5)} |`);
  console.log(`| Re-answers generated          | ${reAnswered.toString().padStart(5)} |`);

  if (baselineResults && targetIds) {
    const baselineMap = new Map(baselineResults.map(r => [r.questionId, r.judgeVerdict]));
    const currentMap = new Map(answerResults.map(r => [r.questionId, r.judgeVerdict]));

    // Among the 29 targets: how many flipped INCORRECT → CORRECT?
    let targetsFixed = 0;
    let targetsTotal = 0;
    for (const id of targetIds) {
      const base = baselineMap.get(id);
      const curr = currentMap.get(id);
      if (base && curr) {
        targetsTotal++;
        if (base === "INCORRECT" && curr === "CORRECT") targetsFixed++;
      }
    }

    // Among baseline-correct (non-target): how many regressed CORRECT → INCORRECT?
    let regressions = 0;
    let regressionTotal = 0;
    for (const [id, baseVerdict] of baselineMap) {
      if (targetIds.has(id)) continue;
      if (baseVerdict === "CORRECT") {
        regressionTotal++;
        const curr = currentMap.get(id);
        if (curr === "INCORRECT") regressions++;
      }
    }

    console.log(`\nSuccess Gate (vs baseline)`);
    console.log(`| Target recoveries (≥15/29 needed)  | ${targetsFixed}/${targetsTotal} |`);
    console.log(`| Baseline regressions (≤3 allowed)  | ${regressions}/${regressionTotal} |`);
    const ratio = regressions > 0 ? (targetsFixed / regressions).toFixed(1) : "∞";
    console.log(`| Fix:regress ratio (≥3:1 needed)    | ${ratio}:1 |`);
    const pass1 = targetsFixed >= 15;
    const pass2 = regressions <= 3 && (regressions === 0 || targetsFixed / regressions >= 3);
    console.log(`| Gate 1 (mechanism)                 | ${pass1 ? "PASS" : "FAIL"} |`);
    console.log(`| Gate 2 (baseline guard)            | ${pass2 ? "PASS" : "FAIL"} |`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  loadEnv();
  const args = parseArgs();
  const { variant, retrievalOnly, limit, skip, topK, promptVariant, thinkingBudget, filterIds, pro, knowledgeLimit, decompose, sessionScoring, reranker: rerankerMode, events: useEvents, eventTopK, twoPass, agentLoop, maxIterations, plannedSearch, noVector, judgeVotes, stratifiedN, gapJudgeEnabled, gapCoverage, gapCoverageRounds, runId } = args;

  configureEmbeddingCache({ enabled: resolveEmbeddingCacheEnabled(process.argv.slice(2), process.env) });

  const thinkingTag = thinkingBudget ? `, thinking=${thinkingBudget}` : "";
  const proTag = pro ? `, pro, knowledgeLimit=${knowledgeLimit}` : "";
  const decomposeTag = decompose ? `, decompose` : "";
  const sessionTag = sessionScoring ? `, session-scoring` : "";
  const rerankerTag = rerankerMode !== "none" ? `, reranker=${rerankerMode}` : "";
  const eventsTag = useEvents ? `, events(top-${eventTopK})` : "";
  const twoPassTag = twoPass ? `, two-pass` : "";
  const agentLoopTag = agentLoop ? `, agent-loop(max=${maxIterations})` : "";
  const plannedSearchTag = plannedSearch ? `, planned-search` : "";
  const judgeVotesTag = judgeVotes > 1 ? `, judge-votes=${judgeVotes}` : "";
  const gapCoverageTag = gapCoverage ? `, gap-coverage(rounds=${gapCoverageRounds})` : "";
  console.log(`LongMemEval Benchmark (LongMemEval${variant.toUpperCase()}, ${retrievalOnly ? "retrieval-only" : "full"}, topK=${topK}, prompt=${promptVariant}${thinkingTag}${proTag}${sessionTag}${rerankerTag}${eventsTag}${twoPassTag}${agentLoopTag}${plannedSearchTag}${judgeVotesTag}${gapCoverageTag})`);
  console.log("=".repeat(60));

  // Load dataset
  const dataset = loadDataset(variant);
  let questions = dataset.slice(skip, skip + limit);
  if (stratifiedN > 0) {
    const { pickStratified } = await import("./stratified-set.js");
    const ids = new Set(pickStratified(dataset, stratifiedN));
    questions = dataset.filter((q) => ids.has(q.question_id));
    console.log(`\nStratified ${stratifiedN}/ability → ${questions.length} questions`);
  } else if (filterIds) {
    questions = questions.filter((q) => filterIds.has(q.question_id));
    console.log(`\nLoaded ${dataset.length} questions, filtered to ${questions.length} by --ids (skip=${skip}, topK=${topK}, prompt=${promptVariant}${thinkingTag})`);
  } else {
    console.log(`\nLoaded ${dataset.length} questions, running ${questions.length} (skip=${skip}, topK=${topK}, prompt=${promptVariant}${thinkingTag})`);
  }

  // Set up LLM providers (only if not retrieval-only)
  let answerProvider: ReturnType<typeof createAnswerProvider> | null = null;
  let judgeProvider: ReturnType<typeof createJudgeProvider> | null = null;

  if (!retrievalOnly) {
    try {
      answerProvider = createAnswerProvider(
        thinkingBudget ? { thinkingBudget } : undefined
      );
      judgeProvider = createJudgeProvider();
      console.log(`Answer model: ${answerProvider.modelName}`);
      console.log(`Judge model:  ${judgeProvider.modelName}`);
      if (promptVariant === "enhanced") {
        console.log(`Prompt:       enhanced (provider-optimized with grounding/abstention/temporal)`);
        if (answerProvider.provider.name === "gemini") {
          console.log(`Temperature:  1.0 (Gemini docs recommend against <1.0)`);
        }
      }
    } catch (err) {
      console.error(
        `\nNo API key found. Set ANTHROPIC_API_KEY or GEMINI_API_KEY for full benchmark.`
      );
      console.error("Falling back to retrieval-only mode.\n");
      answerProvider = null;
      judgeProvider = null;
    }
  }

  // Initialize reranker if requested
  let rerankerInstance: import("../../src/search/reranker/types.js").IReranker | null = null;
  if (rerankerMode !== "none") {
    const { createReranker } = await import("../../src/search/reranker/factory.js");
    rerankerInstance = await createReranker({ provider: rerankerMode });
    console.log(`Reranker:      ${rerankerInstance.name}`);
  }

  // Pre-warm Ollama: load the model into VRAM with keep_alive=-1 before the
  // benchmark loop starts. Avoids two failure modes:
  //   1. Cold-start on Q1 timing out (model load from disk to VRAM is ~5-15s
  //      for a 9 GB model, on top of the actual inference time).
  //   2. Mid-run evictions — without keep_alive, Ollama's default 5-min
  //      timeout will unload the model between any pair of Qs that has a
  //      gap >5 min, causing the next request to "fetch failed".
  if (answerProvider && answerProvider.provider.name === "ollama") {
    const ollamaModel = answerProvider.modelName;
    const ollamaHost = process.env.OLLAMA_HOST ?? "http://localhost:11434";
    const keepAlive = process.env.LONGMEMEVAL_OLLAMA_KEEP_ALIVE ?? "24h";
    console.log(`Pre-warming Ollama (${ollamaModel}) with keep_alive=${keepAlive}...`);
    const prewarmStart = performance.now();
    try {
      const resp = await fetch(`${ollamaHost}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Connection": "close" },
        body: JSON.stringify({
          model: ollamaModel,
          prompt: "hi",
          stream: false,
          keep_alive: keepAlive,
          options: { num_predict: 1 },
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        console.warn(`  ⚠ Pre-warm returned ${resp.status}: ${body.slice(0, 200)}`);
      } else {
        const elapsed = ((performance.now() - prewarmStart) / 1000).toFixed(1);
        console.log(`  ✓ Pre-warmed in ${elapsed}s`);
      }
    } catch (err) {
      console.warn(`  ⚠ Pre-warm failed: ${err instanceof Error ? err.message : String(err)}`);
      console.warn(`    Continuing anyway — first real Q will trigger model load.`);
    }
  }

  // Resume support: load already-completed questions from checkpoint file.
  // When runId is null (flag absent), completed is an empty Map and no checkpoint
  // calls are made — behavior is byte-identical to an uninterrupted run.
  const completed = runId ? loadCompleted(runId) : new Map<string, unknown>();
  if (runId) {
    const remaining = questions.length - completed.size;
    console.log(`\nResuming run-id=${runId}: ${completed.size} already complete, ${remaining} to go`);
  }

  // Phase 1: Retrieval
  if (noVector) {
    console.log(
      "\n*** --no-vector: FTS5-only retrieval — not directly comparable to the published 81.08% baseline (which used hybrid FTS5+vector).\n"
    );
  }
  console.log("\n--- Phase 1: Retrieval ---\n");
  const retrievalResults: RetrievalResult[] = [];
  const answerResults: AnswerResult[] = [];
  const allTokenUsages: TokenUsage[] = [];

  // Open the durable capture DB only when agent-loop mode is active. Captures
  // land in the user's main Strata DB (~/.strata/strata.db by default, or
  // $STRATA_DATA_DIR/strata.db) — distinct from the per-question in-memory DBs
  // that ingest creates. Honors STRATA_NO_CAPTURE=1 as an opt-out for users
  // who don't want benchmark runs writing to their training corpus.
  let captureDb: DatabaseType.Database | null = null;
  if (agentLoop && process.env.STRATA_NO_CAPTURE !== "1") {
    try {
      captureDb = openDatabase();
      console.log(`Capture: writing training pairs to ${process.env.STRATA_DATA_DIR ?? "~/.strata"}/strata.db`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[capture] failed to open capture DB; continuing without capture: ${msg}`);
      captureDb = null;
    }
  }

  for (let i = 0; i < questions.length; i++) {
    const question = questions[i];
    const progress = `[${i + 1}/${questions.length}]`;

    // Resume: if this question was already completed in a prior run, restore
    // its record from the checkpoint and skip all work (no ingest, retrieval,
    // answer, or judge). The restored record goes into answerResults so the
    // final JSON shape is identical to an uninterrupted run.
    if (runId && completed.has(question.question_id)) {
      const restoredRecord = completed.get(question.question_id) as AnswerResult;
      answerResults.push(restoredRecord);
      console.log(`  ${progress} Q${question.question_id}: [resumed from checkpoint]`);
      continue;
    }

    // Ingest this question's haystack
    const ingested = await ingestQuestion(question);

    // Event extraction: load pre-extracted events as structured context
    let knowledgeContext: string | undefined;
    if (useEvents) {
      const cached = loadCachedEvents(question.question_id);
      if (cached && cached.events.length > 0) {
        const relevant = filterEventsByRelevance(cached.events, question.question, eventTopK);
        knowledgeContext = formatEventsForPrompt(relevant, question.question);
      }
    }

    // Pro pipeline: run knowledge extraction on all sessions
    if (pro) {
      try {
        const proResult = await runProExtraction(question, ingested.db);
        const knowledgeEntries = await searchKnowledge(
          proResult.knowledgeStore,
          question.question,
          knowledgeLimit,
          proResult.embedder,
          proResult.vectorSearch
        );
        if (knowledgeEntries.length > 0) {
          knowledgeContext = formatKnowledgeForPrompt(knowledgeEntries);
        }
        process.stdout.write(`  ${progress} Q${question.question_id}: extracted=${proResult.totalEntries}, used=${knowledgeEntries.length} `);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stdout.write(`  ${progress} Q${question.question_id}: [pro error: ${msg}] `);
      }
    }

    // Inject reranker into this question's search engine — skip for multi-session AND temporal
    // OMEGA finding: MS-MARCO-trained rerankers hurt conversational memory.
    // Reranker helps IE/KU by pushing gold session higher in ranking.
    // Reranker hurts multi-session (-6pp) and temporal (-20pp with GPT-4o).
    const skipRerankerForThis = question.question_type === "multi-session" || question.question_type === "temporal-reasoning";
    if (rerankerInstance && rerankerInstance.name !== "none" && !skipRerankerForThis) {
      ingested.searchEngine.setReranker(rerankerInstance);
    }

    // Run retrieval (session-level DCG scoring when --session-scoring flag is set)
    const retrieval = await retrieveQuestion(question, ingested, undefined, { sessionScoring, noVector });
    retrievalResults.push(retrieval);

    const recallStr = `R@5=${retrieval.evidenceRecall5.toFixed(2)} R@10=${retrieval.evidenceRecall10.toFixed(2)} MRR=${retrieval.mrr.toFixed(2)}`;
    if (!pro) {
      process.stdout.write(`  ${progress} Q${question.question_id} (${question.question_type}): ${recallStr}`);
    } else {
      process.stdout.write(`${recallStr}`);
    }

    // Phase 2: Answer + Judge (if not retrieval-only)
    if (answerProvider && judgeProvider) {
      // Reuse search results from retrieval scoring — avoids the two-call
      // consistency bug where separate searchAsync() calls could return
      // different orderings due to non-determinism in vector search / RRF.
      const ftsOnly = process.argv.includes("--fts-only");
      let searchResults;
      if (decompose && isDecomposable(question.question) && answerProvider) {
        searchResults = await decomposedSearch(
          question.question,
          ingested.searchEngine,
          answerProvider.provider,
          { limit: 20 }
        );
      } else if (ftsOnly) {
        searchResults = await ingested.searchEngine.search(
          question.question,
          { limit: 20 }
        );
      } else {
        // Use the same results that were already scored for retrieval metrics
        searchResults = retrieval.searchResults;
      }

      // KU recency boost: for knowledge-update questions, boost recent sessions
      // so the model sees the LATEST value first. OMEGA uses 1.0-1.5x multiplier.
      if (question.question_type === "knowledge-update" && searchResults.length > 1) {
        const timestamps = searchResults.map(r => r.timestamp).filter(t => t > 0);
        if (timestamps.length > 0) {
          const earliest = Math.min(...timestamps);
          const latest = Math.max(...timestamps);
          const span = latest - earliest;
          if (span > 0) {
            for (const r of searchResults) {
              const frac = (r.timestamp - earliest) / span; // 0 = oldest, 1 = newest
              r.score = r.score * (1.0 + 0.5 * frac); // 1.0x oldest, 1.5x newest
            }
            searchResults.sort((a, b) => b.score - a.score);
          }
        }
      }

      // Generate answer
      let answer: string;
      let answerLatency: number;
      let agentLoopData: { iterations: number; toolCallLog: AgentLoopResult["toolCallLog"]; tokenUsage: AgentLoopResult["tokenUsage"] } | undefined;
      let capturedBuffer: CapturePair[] | undefined;
      let questionTokenUsage: TokenUsage | undefined;
      let gapCoverageFired: boolean | undefined;
      let gapNewChunkCount: number | undefined;

      if (plannedSearch) {
        // Planned search mode: cheap planner → deterministic multi-search → GPT-4o answers
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) throw new Error("--planned-search requires OPENAI_API_KEY");
        const { runPlannedSearch } = await import("./planned-search.js");
        const psResult = await withRetry(
          () => runPlannedSearch(apiKey, answerProvider!.modelName, question, ingested),
          3,
          8000
        );
        answer = psResult.answer;
        answerLatency = psResult.latencyMs;
        process.stdout.write(` [plan:${psResult.plan.questionType},${psResult.sessionsUsed}s,${psResult.eventsUsed}e]`);
      } else if (agentLoop) {
        // Agent loop mode: model calls search tools iteratively
        // Route to Gemini or OpenAI agent loop based on answer model provider.
        // Both AI Studio ('gemini-...') and Vertex ('vertex:gemini-...') identifiers
        // are part of the Gemini family for agent-loop dispatch.
        const isGemini =
          answerProvider!.modelName.startsWith("gemini") ||
          answerProvider!.modelName.startsWith("vertex:gemini");

        if (isGemini) {
          // For vertex: prefix, pull the SDK client off the provider and pass
          // the bare model name (without 'vertex:') downstream. AI Studio path
          // still requires GEMINI_API_KEY; Vertex path uses ADC and doesn't.
          const isVertex = answerProvider!.modelName.startsWith("vertex:");
          const vertexClient = isVertex
            ? (answerProvider!.provider as unknown as {
                getGenaiClient: () => unknown;
              }).getGenaiClient()
            : undefined;
          const geminiKey = process.env.GEMINI_API_KEY ?? "";
          if (!isVertex && !geminiKey) {
            throw new Error("--agent-loop with Gemini requires GEMINI_API_KEY (or use vertex: prefix with VERTEX_PROJECT_ID)");
          }
          const bareModel = isVertex
            ? answerProvider!.modelName.slice("vertex:".length)
            : answerProvider!.modelName;
          const { runGeminiAgentLoop } = await import("./gemini-agent-loop.js");
          const loopResult = await withRetry(
            () => runGeminiAgentLoop(geminiKey, bareModel, question, ingested, {
              maxIterations,
              ...(vertexClient ? { vertexClient: vertexClient as never } : {}),
              ...(gapJudgeEnabled ? {
                gapJudge: {
                  enabled: true,
                  complete: (p: string) => answerProvider!.provider.complete(p, { maxTokens: 400, temperature: 0 }),
                }
              } : {}),
            }),
            3,
            8000
          );
          answer = loopResult.answer;
          answerLatency = loopResult.latencyMs;
          capturedBuffer = loopResult.captureBuffer;
          questionTokenUsage = loopResult.tokenUsage;
          const toolSeq = loopResult.toolCallLog
            .map(tc => tc.tool.replace("search_", "s_").replace("get_session", "get").replace("count_sessions", "cnt").replace("knowledge", "know").replace("by_date", "date"))
            .join("→");
          process.stdout.write(` [${loopResult.iterations}it: ${toolSeq}]`);
        } else {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) throw new Error("--agent-loop requires OPENAI_API_KEY");
        const { runAgentLoop } = await import("./agent-loop.js");
        const loopResult = await withRetry(
          () => runAgentLoop(apiKey, answerProvider!.modelName, question, ingested, {
            maxIterations,
            ...(gapJudgeEnabled ? {
              gapJudge: {
                enabled: true,
                complete: (p: string) => answerProvider!.provider.complete(p, { maxTokens: 400, temperature: 0 }),
              }
            } : {}),
          }),
          3,
          8000
        );
        answer = loopResult.answer;
        answerLatency = loopResult.latencyMs;
        capturedBuffer = loopResult.captureBuffer;
        agentLoopData = {
          iterations: loopResult.iterations,
          toolCallLog: loopResult.toolCallLog,
          tokenUsage: loopResult.tokenUsage,
        };
        questionTokenUsage = {
          inputTokens: loopResult.tokenUsage.promptTokens,
          outputTokens: loopResult.tokenUsage.completionTokens,
        };
        const toolSeq = loopResult.toolCallLog
          .map(tc => tc.tool.replace("search_", "s_").replace("get_session", "get").replace("count_sessions", "cnt").replace("knowledge", "know"))
          .join("→");
        process.stdout.write(` [${loopResult.iterations}it: ${toolSeq}]`);
        } // end OpenAI agent loop
      } else {
        const effectiveTopK = topK;

        // Hybrid prompt routing: category prompts for IE/MS/temporal, CoN for KU
        // Category prompts help IE (+7pp), MS (+6pp), temporal (+3pp) but hurt KU (-10pp)
        // CoN prompt is best for KU (95% vs 85% with category prompt)
        // category-reasoning follows the same routing rule: fall back to chain-of-note for KU.
        // category-reasoning-isolated is EXEMPT from the KU fallback: it appends the
        // RECENCY suffix to the KU category prompt to test whether the suffix recovers
        // the KU gap. Routing to CoN would make the KU arm identical to control and
        // untestable. NOTE: this means the KU comparison is (category KU + RECENCY suffix)
        // vs (CoN, via control arm) — two variables — but it is the valid go/no-go signal
        // for whether isolated RECENCY instruction on the category base is worth pursuing.
        const effectiveVariant: PromptVariant = (
          (promptVariant === "category" || promptVariant === "category-reasoning") &&
          question.question_type === "knowledge-update"
        )
          ? "chain-of-note"
          : promptVariant;

        // Single-pass or two-pass mode
        const useTwoPassForThis = twoPass && (isCountingQuestion(question.question) || isDurationQuestion(question.question));
        const answerResult = await withRetry(
          () =>
            useTwoPassForThis
              ? generateAnswerTwoPass(
                  answerProvider!.provider,
                  question.question,
                  question.question_date,
                  searchResults,
                  { topK: effectiveTopK, promptVariant: effectiveVariant, knowledgeContext }
                )
              : generateAnswer(
                  answerProvider!.provider,
                  question.question,
                  question.question_date,
                  searchResults,
                  { topK: effectiveTopK, promptVariant: effectiveVariant, knowledgeContext, questionType: question.question_type }
                ).then(r => ({ ...r, twoPassUsed: false })),
          5,
          2000
        );
        answer = answerResult.answer;
        answerLatency = answerResult.latencyMs;
        const twoPassUsed = 'twoPassUsed' in answerResult ? (answerResult as any).twoPassUsed : false;
        if (twoPassUsed) {
          process.stdout.write(` [2-pass]`);
        }

        // Gap-coverage: one-round sufficiency check (spec 2026-05-31-gap-judge-coverage-wrapper-plan)
        if (gapCoverage && !agentLoop && !plannedSearch) {
          const completeFn = (prompt: string) =>
            answerProvider!.provider.complete(prompt, {
              maxTokens: 500,
              temperature: 0,
            } as any);
          const gcResult = await answerWithGapCoverage(
            question.question,
            question.question_date,
            searchResults,
            answer,
            {
              // Re-retrieval MUST go through retrieveQuestion — the full engineered
              // ranking stack (FTS5 + ONNX rerank + session-scoring + turn-lane fusion).
              // Using searchAsync() directly would bypass the engineered ranker and feed
              // the gap-fill inferior retrieval, defeating the lever's core invariant.
              // Build a synthetic LongMemQuestion with the gap query substituted; all
              // other fields (answer_session_ids etc.) are carried over from `question`
              // but are irrelevant to the search path (only the .question field is used
              // by retrieveQuestion for the FTS5 query). Both `question` and `ingested`
              // are in scope; `sessionScoring` and `noVector` are from args destructuring.
              retrieve: (query: string) =>
                retrieveQuestion(
                  { ...question, question: query },
                  ingested,
                  undefined,
                  { sessionScoring, noVector }
                ).then(r => r.searchResults),
              judgeGap: (q: string, evidence: string) => judgeGap(q, evidence, completeFn),
              generateAnswer: (q: string, qDate: string, ctx: import("../../src/search/sqlite-search-engine.js").SearchResult[], opts?: Record<string, unknown>) =>
                generateAnswer(
                  answerProvider!.provider,
                  q,
                  qDate,
                  ctx,
                  {
                    topK: effectiveTopK,
                    promptVariant: effectiveVariant,
                    knowledgeContext,
                    questionType: question.question_type,
                    ...opts,
                  }
                ),
            },
            { maxRounds: gapCoverageRounds }
          );
          // Always record diagnostics when flag is active
          gapCoverageFired = gcResult.fired;
          gapNewChunkCount = gcResult.newChunkIds.length;
          answer = gcResult.answer;
          // answerLatency reflects the draft; re-answer latency not separately tracked
          // (acceptable for benchmark purposes — the gap-coverage path adds one judge
          // call + one optional answer call, both small relative to the primary answer).
          if (gcResult.fired) {
            process.stdout.write(` [gc:+${gcResult.newChunkIds.length}]`);
          }
        }
      }

      // Rate limit padding between answer and judge calls
      await sleep(4000);

      // Judge answer
      const { verdict, rawResponse, latencyMs: judgeLatency, voteBreakdown } =
        await judgeAnswer(
          judgeProvider!.provider,
          question.question_type,
          question.question_id,
          question.question,
          question.answer,
          answer,
          { votes: judgeVotes }
        );

      // Persist captured training pairs (if any) with judge-backfilled quality.
      // Fires only when agent-loop mode produced a buffer AND the capture DB
      // is open AND the judge returned a definitive verdict. Never throws —
      // capture failures must not affect the primary benchmark path.
      if (captureDb && capturedBuffer && capturedBuffer.length > 0) {
        const judgeVerdict =
          verdict === "CORRECT" || verdict === "INCORRECT" ? verdict : null;
        // Strip the 'vertex:' routing prefix when persisting captures so the
        // training_data row records the model identity ('gemini-2.5-flash'),
        // not the routing layer. Captures from AI Studio and Vertex paths
        // become indistinguishable in the corpus — which is the desired shape
        // for distillation.
        const captureModelName = answerProvider!.modelName.startsWith("vertex:")
          ? answerProvider!.modelName.slice("vertex:".length)
          : answerProvider!.modelName;
        persistCaptureBuffer(captureDb, capturedBuffer, judgeVerdict, captureModelName);
      }

      const ability = questionTypeToAbility(question.question_type);
      const answerRecord: AnswerResult = {
        questionId: question.question_id,
        questionType: question.question_type,
        ability,
        question: question.question,
        goldAnswer: question.answer,
        predictedAnswer: answer,
        judgeVerdict: verdict,
        judgeRawResponse: rawResponse,
        answerModel: answerProvider!.modelName,
        judgeModel: judgeProvider!.modelName,
        answerLatencyMs: answerLatency,
        judgeLatencyMs: judgeLatency,
        ...(agentLoopData ? { agentLoop: agentLoopData } : {}),
        ...(voteBreakdown ? { voteBreakdown } : {}),
        ...(gapCoverageFired !== undefined ? { gapCoverageFired, gapNewChunkCount } : {}),
      };
      answerResults.push(answerRecord);

      // Per-question checkpoint: persist immediately after scoring so a network
      // drop or crash costs at most one question on the next resume.
      // Guard on runId so flag-off is byte-identical to current behavior.
      if (runId) {
        appendResult(runId, answerRecord);
      }

      process.stdout.write(` → ${verdict}`);

      // Accumulate token usage for summary line (agent-loop paths only)
      if (questionTokenUsage) {
        allTokenUsages.push(questionTokenUsage);
      }

      // Rate limit padding between questions — Tier 1 keys have
      // aggressive RPM limits; agent loop needs longer padding (multiple API calls per Q)
      await sleep(agentLoop ? 8000 : 4000);
    }

    closeIngested(ingested);
    process.stdout.write("\n");
  }

  // Report retrieval results
  const retrievalAgg = aggregateRetrieval(retrievalResults);
  printRetrievalReport(retrievalResults, retrievalAgg);

  // Report accuracy results
  if (answerResults.length > 0) {
    printAccuracyReport(
      answerResults,
      answerProvider!.modelName,
      judgeProvider!.modelName
    );
  }

  // Report gap-coverage diagnostics (when --gap-coverage was active)
  if (gapCoverage && answerResults.length > 0) {
    // Load target IDs from companion file if present
    const targetPath = join(__dirname, "gap-coverage-targets.json");
    let targetIds: Set<string> | null = null;
    if (existsSync(targetPath)) {
      try {
        const raw = JSON.parse(readFileSync(targetPath, "utf-8")) as string[];
        targetIds = new Set(raw);
      } catch { /* ignore */ }
    }
    printGapCoverageSummary(answerResults, null, targetIds);
  }

  // Save full results to JSON
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const mode = retrievalOnly ? "retrieval" : "full";
  const promptTag = promptVariant === "enhanced" ? "-enhanced" : "";
  const thinkingFileTag = thinkingBudget ? `-think${thinkingBudget}` : "";
  const proFileTag = pro ? `-pro-kl${knowledgeLimit}` : "";
  const sessionFileTag = sessionScoring ? "-session" : "";
  const rerankerFileTag = rerankerMode !== "none" ? `-rerank-${rerankerMode}` : "";
  const eventsFileTag = useEvents ? `-events-top${eventTopK}` : "";
  const twoPassFileTag = twoPass ? `-2pass` : "";
  const agentLoopFileTag = agentLoop ? `-agent` : "";
  const plannedSearchFileTag = plannedSearch ? `-planned` : "";
  const resultsPath = join(DATA_DIR, `results-${mode}-topk${topK}${promptTag}${thinkingFileTag}${proFileTag}${sessionFileTag}${rerankerFileTag}${eventsFileTag}${twoPassFileTag}${agentLoopFileTag}${plannedSearchFileTag}-${timestamp}.json`);

  const results: Partial<BenchmarkResults> & { topK?: number; promptVariant?: string; thinkingBudget?: number; pro?: boolean; knowledgeLimit?: number } = {
    variant,
    searchMode: process.env.GEMINI_API_KEY ? "hybrid" : "bm25",
    timestamp: new Date().toISOString(),
    numQuestions: questions.length,
    topK,
    promptVariant,
    ...(thinkingBudget ? { thinkingBudget } : {}),
    ...(pro ? { pro: true, knowledgeLimit } : {}),
    retrieval: retrievalAgg,
  };

  if (answerResults.length > 0) {
    const byAbility = new Map<
      MemoryAbility,
      { correct: number; total: number }
    >();
    for (const r of answerResults) {
      const entry = byAbility.get(r.ability) || { correct: 0, total: 0 };
      entry.total++;
      if (r.judgeVerdict === "CORRECT") entry.correct++;
      byAbility.set(r.ability, entry);
    }

    const abilityScores: AbilityScore[] = [];
    for (const [ability, entry] of byAbility) {
      abilityScores.push({
        ability,
        ...entry,
        accuracy: entry.total > 0 ? (entry.correct / entry.total) * 100 : 0,
      });
    }

    const taskAveraged =
      abilityScores.reduce((s, a) => s + a.accuracy, 0) / abilityScores.length;
    const totalCorrect = answerResults.filter(
      (r) => r.judgeVerdict === "CORRECT"
    ).length;

    results.accuracy = {
      raw: (totalCorrect / answerResults.length) * 100,
      rawCount: totalCorrect,
      taskAveraged,
      byAbility: abilityScores,
    };
    results.models = {
      answerModel: answerProvider!.modelName,
      judgeModel: judgeProvider!.modelName,
    };

    // Answer-model + judge latency aggregates — added 2026-05-29 so future
    // results can claim defensible end-to-end p50/p95/p99 numbers. Honcho,
    // Mem0, Zep, and Letta all publish ZERO latency numbers; ByteRover is
    // the only competitor that does (1.3s mean / 1.6s p50 / 2.3s p95 / 2.5s
    // p99 on LongMemEval-S). Surfacing this lets Strata own the dimension.
    results.answerLatency = summariseLatency(
      answerResults.map((r) => r.answerLatencyMs).filter((x) => Number.isFinite(x))
    );
    results.judgeLatency = summariseLatency(
      answerResults.map((r) => r.judgeLatencyMs).filter((x) => Number.isFinite(x))
    );

    // Per-question verdicts for post-hoc analysis across runs
    (results as Record<string, unknown>).perQuestion = answerResults.map(r => ({
      questionId: r.questionId,
      questionType: r.questionType,
      question: r.question,
      goldAnswer: r.goldAnswer,
      predictedAnswer: r.predictedAnswer,
      judgeVerdict: r.judgeVerdict,
      answerLatencyMs: r.answerLatencyMs,
      judgeLatencyMs: r.judgeLatencyMs,
      ...(r.voteBreakdown ? { voteBreakdown: r.voteBreakdown } : {}),
    }));
  }

  const embedStats = getEmbeddingCacheStats();
  if (embedStats) {
    const total = embedStats.hits + embedStats.misses;
    const pct = total > 0 ? ((embedStats.hits / total) * 100).toFixed(1) : "0.0";
    console.log(`\nEmbedding cache: ${embedStats.hits} hits / ${embedStats.misses} misses (${pct}% hit rate)`);
  } else {
    console.log(`\nEmbedding cache: disabled`);
  }

  // Token/cost summary for agent-loop runs (bake-off visibility)
  if (allTokenUsages.length > 0) {
    const answerModelName = answerProvider?.modelName ?? "";
    const tok = summariseTokens(allTokenUsages);
    const cost = computeCost(answerModelName, tok.totalInput, tok.totalOutput);
    console.log(`\nTokens: ${tok.totalInput} in / ${tok.totalOutput} out (mean ${Math.round(tok.meanInputPerQ)} in/Q) — est. $${cost.toFixed(2)}`);
  }

  writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to ${resultsPath}`);

  if (captureDb) {
    try { captureDb.close(); } catch { /* already closed */ }
  }
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
