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
import { ingestQuestion, closeIngested } from "./ingest.js";
import { retrieveQuestion, aggregateRetrieval } from "./retrieve.js";
import { generateAnswer, generateAnswerTwoPass, isCountingQuestion, isDurationQuestion, sleep, withRetry } from "./answer.js";
import type { PromptVariant } from "./answer.js";
import type { AgentLoopResult } from "./agent-loop.js";
import type { GeminiAgentLoopResult } from "./gemini-agent-loop.js";
import type { PlannedSearchResult } from "./planned-search.js";
import { judgeAnswer } from "./judge.js";
import { createAnswerProvider, createJudgeProvider } from "./providers/provider-factory.js";
import { runProExtraction, searchKnowledge, formatKnowledgeForPrompt } from "./pro-pipeline.js";
import { isDecomposable, decomposedSearch } from "./query-decomposer.js";
import { loadCachedEvents, formatEventsForPrompt, filterEventsByRelevance } from "./extract-events.js";
import { expandQuery, filterByRelevance } from "./query-expansion.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");

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

function parseArgs(): {
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

  return { variant, retrievalOnly, limit, skip, topK, promptVariant, thinkingBudget, filterIds, pro, knowledgeLimit, decompose, sessionScoring, reranker, events, eventTopK, twoPass, agentLoop, maxIterations, plannedSearch, noVector };
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
// Main
// ---------------------------------------------------------------------------

async function main() {
  loadEnv();
  const args = parseArgs();
  const { variant, retrievalOnly, limit, skip, topK, promptVariant, thinkingBudget, filterIds, pro, knowledgeLimit, decompose, sessionScoring, reranker: rerankerMode, events: useEvents, eventTopK, twoPass, agentLoop, maxIterations, plannedSearch, noVector } = args;

  const thinkingTag = thinkingBudget ? `, thinking=${thinkingBudget}` : "";
  const proTag = pro ? `, pro, knowledgeLimit=${knowledgeLimit}` : "";
  const decomposeTag = decompose ? `, decompose` : "";
  const sessionTag = sessionScoring ? `, session-scoring` : "";
  const rerankerTag = rerankerMode !== "none" ? `, reranker=${rerankerMode}` : "";
  const eventsTag = useEvents ? `, events(top-${eventTopK})` : "";
  const twoPassTag = twoPass ? `, two-pass` : "";
  const agentLoopTag = agentLoop ? `, agent-loop(max=${maxIterations})` : "";
  const plannedSearchTag = plannedSearch ? `, planned-search` : "";
  console.log(`LongMemEval Benchmark (LongMemEval${variant.toUpperCase()}, ${retrievalOnly ? "retrieval-only" : "full"}, topK=${topK}, prompt=${promptVariant}${thinkingTag}${proTag}${sessionTag}${rerankerTag}${eventsTag}${twoPassTag}${agentLoopTag}${plannedSearchTag})`);
  console.log("=".repeat(60));

  // Load dataset
  const dataset = loadDataset(variant);
  let questions = dataset.slice(skip, skip + limit);
  if (filterIds) {
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

  // Phase 1: Retrieval
  if (noVector) {
    console.log(
      "\n*** --no-vector: FTS5-only retrieval — not directly comparable to the published 81.08% baseline (which used hybrid FTS5+vector).\n"
    );
  }
  console.log("\n--- Phase 1: Retrieval ---\n");
  const retrievalResults: RetrievalResult[] = [];
  const answerResults: AnswerResult[] = [];

  for (let i = 0; i < questions.length; i++) {
    const question = questions[i];
    const progress = `[${i + 1}/${questions.length}]`;

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
        // Route to Gemini or OpenAI agent loop based on answer model provider
        const isGemini = answerProvider!.modelName.startsWith("gemini");

        if (isGemini) {
          const geminiKey = process.env.GEMINI_API_KEY;
          if (!geminiKey) throw new Error("--agent-loop with Gemini requires GEMINI_API_KEY");
          const { runGeminiAgentLoop } = await import("./gemini-agent-loop.js");
          const loopResult = await withRetry(
            () => runGeminiAgentLoop(geminiKey, answerProvider!.modelName, question, ingested, { maxIterations }),
            3,
            8000
          );
          answer = loopResult.answer;
          answerLatency = loopResult.latencyMs;
          const toolSeq = loopResult.toolCallLog
            .map(tc => tc.tool.replace("search_", "s_").replace("get_session", "get").replace("count_sessions", "cnt").replace("knowledge", "know").replace("by_date", "date"))
            .join("→");
          process.stdout.write(` [${loopResult.iterations}it: ${toolSeq}]`);
        } else {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) throw new Error("--agent-loop requires OPENAI_API_KEY");
        const { runAgentLoop } = await import("./agent-loop.js");
        const loopResult = await withRetry(
          () => runAgentLoop(apiKey, answerProvider!.modelName, question, ingested, { maxIterations }),
          3,
          8000
        );
        answer = loopResult.answer;
        answerLatency = loopResult.latencyMs;
        agentLoopData = {
          iterations: loopResult.iterations,
          toolCallLog: loopResult.toolCallLog,
          tokenUsage: loopResult.tokenUsage,
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
        const effectiveVariant: PromptVariant = (promptVariant === "category" && question.question_type === "knowledge-update")
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
      }

      // Rate limit padding between answer and judge calls
      await sleep(4000);

      // Judge answer
      const { verdict, rawResponse, latencyMs: judgeLatency } =
        await judgeAnswer(
          judgeProvider!.provider,
          question.question_type,
          question.question_id,
          question.question,
          question.answer,
          answer
        );

      const ability = questionTypeToAbility(question.question_type);
      answerResults.push({
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
      });

      process.stdout.write(` → ${verdict}`);

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

    // Per-question verdicts for post-hoc analysis across runs
    (results as Record<string, unknown>).perQuestion = answerResults.map(r => ({
      questionId: r.questionId,
      questionType: r.questionType,
      question: r.question,
      goldAnswer: r.goldAnswer,
      predictedAnswer: r.predictedAnswer,
      judgeVerdict: r.judgeVerdict,
    }));
  }

  writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to ${resultsPath}`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
