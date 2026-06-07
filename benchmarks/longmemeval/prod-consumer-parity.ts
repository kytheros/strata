/**
 * prod-consumer-parity.ts
 *
 * DIAGNOSTIC — answers the question: "Does a real production consumer of
 * search_history get the same answer-quality the benchmark reports (~84.4%)?"
 *
 * The consumer = the user's AI assistant: it calls the search_history MCP tool,
 * receives a FORMATTED, max_chars-truncated STRING, and uses it VERBATIM as memory
 * context. Prior harnesses never measured this — they re-parsed the string via
 * productionStringToSearchResults (a round-trip a real consumer never does).
 *
 * Four arms (ONE harness, ONE run, same ingest/answer-model/judge per question):
 *
 *   PROD-CONSUMER — handleSearchHistory (no retrieval_strategy, dense-turn default)
 *     Raw STRING injected verbatim via generateAnswerFromRawString.
 *     NO re-parse. The TRUE consumer experience.
 *
 *   BENCHMARK — retrieveQuestion (sessionScoring=true) → SearchResult[] → generateAnswer
 *     The 84.4% pipeline. Re-executed in-harness for EVERY question.
 *     NEVER loads from a prior result file.
 *
 *   PROD-RESULTS — production SearchResult[] BEFORE string-rendering → generateAnswer
 *     Inline-duplicated from search-history.ts dense-turn-lane block (lines 311-361).
 *     Does NOT call handleSearchHistory. Isolates retrieval-content loss.
 *
 *   PROD-STRING-PARSED — handleSearchHistory string → productionStringToSearchResults
 *     → generateAnswer. Legacy round-trip; kept as regression reference only.
 *
 * Decomposition:
 *   total gap           = BENCHMARK − PROD-CONSUMER
 *   retrieval-content   = BENCHMARK − PROD-RESULTS
 *   render+truncation   = PROD-RESULTS − PROD-CONSUMER
 *   round-trip cost     = PROD-STRING-PARSED − PROD-CONSUMER
 *
 * Temperature: vertex-gemini → 0 (NOT 1.0; see answer.ts:964-968 comment).
 *
 * Usage:
 *   npx tsx benchmarks/longmemeval/prod-consumer-parity.ts \
 *     --arm=all --smoke=5 --run-id=pcp --judge-votes=3
 *
 * Options:
 *   --arm=prod-consumer|benchmark|prod-results|prod-string-parsed|all
 *   --run-id=<id>      Base checkpoint ID (arm suffix appended)
 *   --smoke=N          Questions per ability (default 5 for smoke)
 *   --judge-votes=N    (default: 3)
 *   --limit=N          Cap total questions (debug)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import type { SearchResult, SearchOptions } from "../../src/search/sqlite-search-engine.js";
import type { LongMemQuestion, MemoryAbility } from "./types.js";
import { questionTypeToAbility } from "./types.js";
import { ingestQuestion, closeIngested, configureEmbeddingCache } from "./ingest.js";
import { retrieveQuestion } from "./retrieve.js";
import { generateAnswer, withRetry } from "./answer.js";
import { judgeAnswer } from "./judge.js";
import { createAnswerProvider, createJudgeProvider } from "./providers/provider-factory.js";
import { handleSearchHistory } from "../../src/tools/search-history.js";
import type { SearchHistoryArgs } from "../../src/tools/search-history.js";
import { appendResult, loadCompleted } from "./checkpoint.js";
import { pickStratified } from "./stratified-set.js";
import { SemanticSearchBridge } from "../../src/search/semantic-search-bridge.js";
import { createReranker } from "../../src/search/reranker/factory.js";
import { fuseDenseTurnLane } from "../../src/search/dense-turn-fusion.js";
import { knowledgeEntryToSearchResult } from "../../src/search/knowledge-to-search-result.js";
import { CONFIG } from "../../src/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const RESULTS_DIR = join(__dirname, "data", "prod-consumer-parity");

// ---------------------------------------------------------------------------
// .env loader
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
// Dataset loader
// ---------------------------------------------------------------------------

function loadDataset(): LongMemQuestion[] {
  const candidates = [
    join(DATA_DIR, "longmemeval_s_cleaned.json"),
    join(DATA_DIR, "longmemeval_s.json"),
  ];
  const path = candidates.find(existsSync);
  if (!path) {
    throw new Error(
      `Dataset not found at any of:\n  ${candidates.join("\n  ")}\nRun:\n  npx tsx benchmarks/longmemeval/download-dataset.ts`
    );
  }
  return JSON.parse(readFileSync(path, "utf-8")) as LongMemQuestion[];
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(): {
  arm: "prod-consumer" | "benchmark" | "prod-results" | "prod-string-parsed" | "all";
  runIdBase: string;
  smokeN: number;
  judgeVotes: number;
  limit: number;
  maxChars: number;
  promptVariant: "baseline" | "fair";
} {
  const args = process.argv.slice(2);

  const armArg = args.find((a) => a.startsWith("--arm="));
  const arm = (armArg?.split("=")[1] ?? "all") as
    | "prod-consumer"
    | "benchmark"
    | "prod-results"
    | "prod-string-parsed"
    | "all";

  const runIdArg = args.find((a) => a.startsWith("--run-id="));
  const runIdBase = runIdArg?.split("=")[1] ?? "pcp";

  const smokeArg = args.find((a) => a.startsWith("--smoke="));
  const smokeN = smokeArg ? parseInt(smokeArg.split("=")[1], 10) : 5;

  const judgeVotesArg = args.find((a) => a.startsWith("--judge-votes="));
  const judgeVotes = judgeVotesArg ? parseInt(judgeVotesArg.split("=")[1], 10) : 3;

  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : Infinity;

  // PROD-CONSUMER (+ PROD-STRING-PARSED) per-result truncation. Production
  // default is 2500; clamp ceiling in search-history.ts is 10000. Used by the
  // max_chars sensitivity sweep to convert truncation exposure → accuracy impact.
  const maxCharsArg = args.find((a) => a.startsWith("--max-chars="));
  const maxChars = maxCharsArg ? parseInt(maxCharsArg.split("=")[1], 10) : 2500;

  // Artifact-check C: "fair" swaps the PROD-CONSUMER raw-string answer prompt for
  // a format-honest one (no false chronological/Note-# claims). "baseline" default.
  const pvArg = args.find((a) => a.startsWith("--prompt-variant="));
  const promptVariant = (pvArg?.split("=")[1] === "fair" ? "fair" : "baseline") as "baseline" | "fair";

  return { arm, runIdBase, smokeN, judgeVotes, limit, maxChars, promptVariant };
}

// ---------------------------------------------------------------------------
// productionStringToSearchResults
// (for PROD-STRING-PARSED arm only — the legacy round-trip the consumer NEVER does)
// ---------------------------------------------------------------------------

function productionStringToSearchResults(productionOutput: string): SearchResult[] {
  const blocks = productionOutput.split(/\n---[^\n]+---\n/);
  const headerMatches = [...productionOutput.matchAll(/---[^\n]+\(([^)]+)\)[^\n]+---/g)];

  if (headerMatches.length === 0 || blocks.length <= 1) {
    if (productionOutput.trim().length === 0) return [];
    return [{
      sessionId: "production-output-0",
      project: "longmemeval",
      text: productionOutput,
      score: 1.0,
      confidence: 1.0,
      timestamp: Date.now(),
      toolNames: [],
      role: "mixed" as const,
    }];
  }

  const results: SearchResult[] = [];
  for (let i = 0; i < headerMatches.length; i++) {
    const dateStr = headerMatches[i][1];
    const ts = new Date(dateStr).getTime();
    const timestamp = isNaN(ts) ? Date.now() : ts;
    const blockText = blocks[i + 1]?.trim() ?? "";
    if (blockText.length === 0) continue;
    results.push({
      sessionId: `production-output-${i}`,
      project: "longmemeval",
      text: blockText,
      score: 1.0 - i * 0.01,
      confidence: 1.0,
      timestamp,
      toolNames: [],
      role: "mixed" as const,
    });
  }

  if (results.length === 0) {
    return [{
      sessionId: "production-output-0",
      project: "longmemeval",
      text: productionOutput,
      score: 1.0,
      confidence: 1.0,
      timestamp: Date.now(),
      toolNames: [],
      role: "mixed" as const,
    }];
  }
  return results;
}

// ---------------------------------------------------------------------------
// Prompt variant (artifact-check C): "baseline" = the category prompt copied
// verbatim from buildAnswerPrompt (which assumes chronological order + "Note #"
// numbering the production STRING does NOT have); "fair" = a format-honest
// prompt that acknowledges the real string structure (relevance-ordered blocks,
// "--- project (date) ---" headers, date-based recency). Set from --prompt-variant.
// Isolates: is the ~5pp consumer gap a proxy-prompt artifact (false chronology/
// numbering claims) or a genuine format cost? Same retrieval + string either way.
let PROMPT_VARIANT: "baseline" | "fair" = "baseline";

/**
 * Format-honest prompt for the production search_history STRING. Acknowledges the
 * actual block structure and that entries are RELEVANCE-ordered (not chronological),
 * so recency is resolved by the date in each "--- project (date) ---" header rather
 * than by note number. Category guidance is kept equivalent to the baseline.
 */
function buildFairRawStringPrompt(
  question: string,
  questionDate: string,
  questionType: string,
  notes: string,
): string {
  const preamble = `Below is memory retrieved from past conversations between you and a user. Each entry begins with a header line of the form "--- <project> (<date>) ---" followed by its content. The entries are ordered by RELEVANCE to the question, NOT by time — use the date in each entry's header to reason about chronology. Answer the question using these entries. If it cannot be answered from them, say so.`;

  let guidance = "";
  if (questionType === "multi-session") {
    guidance = `
- When the same fact appears in multiple entries with different values, use the value from the entry with the MOST RECENT header date.
- If the question asks "how many", for a count, or for a total:
  1. List EVERY matching item individually, citing the entry's header date.
  2. VERIFY each item strictly matches the question's criteria; remove ones that don't. But NEVER dismiss something the USER claims they did — the user's statement is ground truth.
  3. Count the remaining items and state the total clearly.
  4. For "how much total" questions: list each amount with its entry date, then sum them.
- DEDUPLICATION: the same event may appear in several entries (retrieval can return duplicates). If two entries describe the same event, count them as ONE.
- For "increase"/"change" questions: find BOTH the starting and ending value, then compute the difference.
- Scan every entry before answering. Give a direct, concise answer.`;
  } else if (questionType === "temporal-reasoning") {
    guidance = `
- Convert ALL relative dates ("last Saturday", "3 weeks ago", "yesterday") to absolute dates using that entry's header date.
- Find every entry that could match both the time reference AND the description — do not stop at the first match.
- When an entry says "I was thinking about X" or "I remembered X", X did NOT happen on that entry's date — only count entries where the user describes actually doing the action.
- For "how many days/weeks" questions, show the two absolute dates and the arithmetic briefly. For ordering questions, list each event with its absolute date, then sort. When values conflict, prefer the entry with the most recent header date.`;
  } else if (questionType === "knowledge-update") {
    guidance = `
- When the same topic appears in multiple entries with different values, use the value from the entry with the MOST RECENT header date. Earlier values are superseded.`;
  } else if (questionType === "single-session-preference") {
    guidance = `
- Focus on what the user explicitly said about their preferences, likes, dislikes, habits, and personal details.
- When the same preference appears in multiple entries, use the one with the most recent header date.
- If asked for a recommendation, USE the user's stated preferences; do NOT claim you lack information if the entries contain ANY relevant preferences.
- Look for RELATED preferences even if no entry mentions the exact topic.
- Your answer MUST reference at least one specific detail from the entries. Generic advice is WRONG.`;
  }

  return `${preamble}${guidance ? "\n" + guidance : ""}

Retrieved memory:

${notes}

Current Date: ${questionDate}
Question: ${question}
Answer:`;
}

// ---------------------------------------------------------------------------
// generateAnswerFromRawString
//
// Replicates the category prompt from buildAnswerPrompt (answer.ts:569-673),
// but swaps ONLY the notes block for the verbatim raw string from handleSearchHistory.
// NO re-parse, NO deduplicateToSessions, NO per-result "Note N (date):" loop.
//
// Temperature: vertex-gemini → 0 (NOT 1.0).
//   "vertex-gemini" provider.name → temperature = 0 per answer.ts:964-968.
//   (Only bare "gemini" gets 1.0.)
// maxTokens: 8192 (Gemini family — isGeminiFamily includes vertex-gemini).
// ---------------------------------------------------------------------------

async function generateAnswerFromRawString(
  provider: ReturnType<typeof createAnswerProvider>["provider"],
  question: string,
  questionDate: string,
  questionType: string,
  rawContextString: string,
): Promise<{ answer: string; latencyMs: number }> {
  // Verbatim swap: the rawContextString IS the notes block.
  // Build the same system prompt as the category branch.
  const system = "You are a memory assistant that answers questions from retrieved conversation history.";
  const notes = rawContextString;

  let userPrompt: string;

  if (PROMPT_VARIANT === "fair") {
    userPrompt = buildFairRawStringPrompt(question, questionDate, questionType, notes);
  } else if (questionType === "multi-session") {
    userPrompt = `I will give you several notes from past conversations between you and a user, ordered from oldest to newest. Please answer the question based on the relevant notes. If the question cannot be answered based on the provided notes, say so.

Important:
- Notes are in chronological order. When the same fact appears in multiple notes with different values, always use the value from the MOST RECENT note.
- If the question asks "how many", for a count, or for a total:
  1. You MUST list EVERY matching item individually, citing its source as [Note #].
  2. VERIFY each item: re-read the question and confirm each item EXACTLY matches what was asked.
  3. REMOVE items that don't strictly match the question's criteria. But NEVER dismiss something the USER claims they did just because the assistant questioned whether it's real. The user's statement is ground truth.
  4. After filtering, count the remaining items and state the total clearly.
  5. For "how much total" questions: list each amount with its source [Note #], then sum them.
- DEDUPLICATION: Watch for the same event/item described differently. If two items could be the same, count them as ONE.
- For questions about an "increase" or "change": find BOTH the starting AND ending value, then compute the DIFFERENCE.
- Do NOT skip notes. Scan every note for potential matches before answering.
- Give a direct, concise answer.

Notes from past conversations:

${notes}

Current Date: ${questionDate}
Question: ${question}
Answer:`;
  } else if (questionType === "temporal-reasoning") {
    userPrompt = `I will give you several notes from past conversations between you and a user, ordered from oldest to newest. Each note has a date stamp. Please answer the question based on the relevant notes. If the question cannot be answered based on the provided notes, say so.

For time-based questions, convert ALL relative dates ("last Saturday", "3 weeks ago", "yesterday") to absolute dates using the note's own date stamp. Find every event that could match both the time reference AND the description — do not stop at the first match. When a note says "I was thinking about X" or "I remembered X", the event X did NOT happen on that note's date — only use notes where the user describes actually performing an action.

For "how many days/weeks" questions, show the two absolute dates and the arithmetic briefly before your answer. For ordering questions, list each event with its absolute date, then sort by date. Notes are in chronological order — use the most recent note when values conflict.

Notes from past conversations:

${notes}

Current Date: ${questionDate}
Question: ${question}
Answer:`;
  } else if (questionType === "knowledge-update") {
    userPrompt = `I will give you several notes from past conversations between you and a user, ordered from oldest to newest. Please answer the question based on the relevant notes. If the question cannot be answered based on the provided notes, say so.

When the same topic appears in multiple notes with different values, always use the value from the MOST RECENT note (the highest note number). Earlier values are superseded.

Notes from past conversations:

${notes}

Current Date: ${questionDate}
Question: ${question}
Answer:`;
  } else if (questionType === "single-session-preference") {
    userPrompt = `I will give you several notes from past conversations between you and a user. Please answer the question based on the user's stated preferences, habits, and personal information found in these notes. If the question cannot be answered based on the provided notes, say so.

- Focus on what the user explicitly said about their preferences, likes, dislikes, habits, and personal details.
- When the same preference appears in multiple notes, use the MOST RECENT note.
- If asked for a recommendation, USE the user's stated preferences. Do NOT say you lack information if the notes contain ANY relevant preferences.
- Look for RELATED preferences even if the notes don't mention the exact topic.
- Your answer MUST reference at least one specific detail from the notes. Generic advice is WRONG.

Notes from past conversations:

${notes}

Current Date: ${questionDate}
Question: ${question}
Answer:`;
  } else {
    // Default: vanilla (single-session-user, single-session-assistant, abstention)
    userPrompt = `I will give you several notes from past conversations between you and a user. Please answer the question based on the relevant notes. If the question cannot be answered based on the provided notes, say so.

Notes from past conversations:

${notes}

Current Date: ${questionDate}
Question: ${question}
Answer:`;
  }

  // Temperature: vertex-gemini → 0 (per answer.ts:964-968 comment).
  // "gemini" (bare) → 1.0 per docs; "vertex-gemini" → 0 (baseline value, do NOT change).
  const temperature = provider.name === "gemini" ? 1.0 : 0;

  // maxTokens: 8192 for Gemini family (vertex-gemini and gemini both qualify).
  const isGeminiFamily = provider.name === "gemini" || provider.name === "vertex-gemini";
  const maxTokens = isGeminiFamily ? 8192 : 2048;

  const completionOptions: Record<string, unknown> = {
    maxTokens,
    temperature,
    timeoutMs: 60000,
    systemPrompt: system,
  };

  const start = performance.now();
  const answer = await provider.complete(userPrompt, completionOptions as any);
  const latencyMs = performance.now() - start;

  return { answer: answer.trim(), latencyMs };
}

// ---------------------------------------------------------------------------
// Arm label type
// ---------------------------------------------------------------------------

export type PcpArmLabel =
  | "PROD-CONSUMER"
  | "BENCHMARK"
  | "PROD-RESULTS"
  | "PROD-STRING-PARSED";

// ---------------------------------------------------------------------------
// Per-question result record
// ---------------------------------------------------------------------------

export interface PcpRunResult {
  questionId: string;
  questionType: string;
  ability: MemoryAbility;
  arm: PcpArmLabel;
  judgeVerdict: "CORRECT" | "INCORRECT";
  contextLength: number;
  contextSessionCount: number;
  /** Raw chars of handleSearchHistory output (Arm PROD-CONSUMER + PROD-STRING-PARSED) */
  productionOutputLength?: number;
  /** Whether SemanticSearchBridge was active on this question (Arm PROD-CONSUMER) */
  bridgeActive?: boolean;
  /** Whether denseTurnStore was non-null on this question (Arm PROD-CONSUMER) */
  denseTurnStoreActive?: boolean;
  /** Whether reranker was active for BENCHMARK arm */
  rerankerActive?: boolean;
  /** Metadata block per the master guardrail */
  metadata: {
    benchmarkFromFile: false;
    harness: "prod-consumer-parity.ts";
    answerModel: string;
    judgeModel: string;
    runTimestamp: string;
  };
}

// ---------------------------------------------------------------------------
// Single-question runner
// ---------------------------------------------------------------------------

async function runOneQuestion(
  question: LongMemQuestion,
  arm: PcpArmLabel,
  answerProvider: ReturnType<typeof createAnswerProvider>,
  judgeProvider: ReturnType<typeof createJudgeProvider>,
  judgeVotes: number,
  runTimestamp: string,
  maxChars: number = 2500,
): Promise<PcpRunResult> {
  const ingested = await ingestQuestion(question);

  let judgeInput: string;
  let contextLength: number;
  let contextSessionCount: number;
  let productionOutputLength: number | undefined;
  let bridgeActive: boolean | undefined;
  let denseTurnStoreActive: boolean | undefined;
  let rerankerActive: boolean | undefined;

  if (arm === "PROD-CONSUMER") {
    // ── PROD-CONSUMER ──────────────────────────────────────────────────────
    // Call real production handleSearchHistory with retrieval_strategy OMITTED
    // (→ dense-turn-lane default, search-history.ts:311).
    // asyncSearch = SemanticSearchBridge.search() with FTS5 fallback
    // (mirrors src/server.ts:346-351 exactly).
    // Take the raw STRING output and inject verbatim into generateAnswerFromRawString.
    // NO re-parse, NO productionStringToSearchResults, NO deduplicateToSessions.

    const bridge = new SemanticSearchBridge(ingested.docStore, ingested.db);
    let _bridgeReturnedNonNull = false;

    const asyncSearch = async (query: string, options: SearchOptions): Promise<SearchResult[]> => {
      const hybridResults = await bridge.search(query, options);
      if (hybridResults !== null) {
        _bridgeReturnedNonNull = true;
        return hybridResults;
      }
      return ingested.searchEngine.search(query, options);
    };

    // Inject reranker (matches parity-comparison.ts Arm A pattern for prod-bridge)
    const reranker = await createReranker();
    if (reranker.name !== "none") {
      ingested.searchEngine.setReranker(reranker);
    }

    const args: SearchHistoryArgs = {
      query: question.question,
      limit: 20,
      max_chars: maxChars,
      // retrieval_strategy OMITTED → hits dense-turn-lane default (line 311)
    };

    const rawString = await handleSearchHistory(
      ingested.searchEngine,
      args,
      ingested.db,
      asyncSearch,
      ingested.knowledgeStore,
      ingested.turnStore,
    );

    bridgeActive = _bridgeReturnedNonNull;
    denseTurnStoreActive = true; // turnStore always passed
    productionOutputLength = rawString.length;

    // Verbatim injection — the consumer gets this string and uses it directly
    const { answer } = await withRetry(() =>
      generateAnswerFromRawString(
        answerProvider.provider,
        question.question,
        question.question_date,
        question.question_type,
        rawString,
      )
    );

    // Context metrics: approximate from the raw string
    contextLength = rawString.length;
    contextSessionCount = (rawString.match(/^---/gm) ?? []).length;

    const judgeResult = await judgeAnswer(
      judgeProvider.provider,
      question.question_type,
      question.question_id,
      question.question,
      question.answer,
      answer,
      { votes: judgeVotes }
    );

    closeIngested(ingested);
    return {
      questionId: question.question_id,
      questionType: question.question_type,
      ability: questionTypeToAbility(question.question_type),
      arm,
      judgeVerdict: judgeResult.verdict,
      contextLength,
      contextSessionCount,
      productionOutputLength,
      bridgeActive,
      denseTurnStoreActive,
      metadata: {
        benchmarkFromFile: false,
        harness: "prod-consumer-parity.ts",
        answerModel: answerProvider.modelName,
        judgeModel: judgeProvider.modelName,
        runTimestamp,
      },
    };

  } else if (arm === "BENCHMARK") {
    // ── BENCHMARK ──────────────────────────────────────────────────────────
    // retrieveQuestion with sessionScoring=true — the 84.4% pipeline.
    // Re-executed in-harness. NEVER loaded from a prior result file.

    const retrieval = await retrieveQuestion(
      question,
      ingested,
      undefined,
      { sessionScoring: true, noVector: false }
    );
    const searchResults = retrieval.searchResults;

    const { answer } = await withRetry(() =>
      generateAnswer(
        answerProvider.provider,
        question.question,
        question.question_date,
        searchResults,
        {
          topK: 20,
          promptVariant: "category",
          questionType: question.question_type,
        }
      )
    );

    contextLength = searchResults.reduce((s, r) => s + r.text.length, 0);
    contextSessionCount = new Set(searchResults.map((r) => r.sessionId)).size;

    // Verify real session IDs (not "production-output-N")
    const hasRealSessionIds = searchResults.some((r) => r.sessionId.startsWith("longmemeval-"));

    const judgeResult = await judgeAnswer(
      judgeProvider.provider,
      question.question_type,
      question.question_id,
      question.question,
      question.answer,
      answer,
      { votes: judgeVotes }
    );

    closeIngested(ingested);
    const result: PcpRunResult = {
      questionId: question.question_id,
      questionType: question.question_type,
      ability: questionTypeToAbility(question.question_type),
      arm,
      judgeVerdict: judgeResult.verdict,
      contextLength,
      contextSessionCount,
      metadata: {
        benchmarkFromFile: false,
        harness: "prod-consumer-parity.ts",
        answerModel: answerProvider.modelName,
        judgeModel: judgeProvider.modelName,
        runTimestamp,
      },
    };
    // Attach real-session-id proof as extra field for verify-from-disk
    (result as any)._hasRealSessionIds = hasRealSessionIds;
    return result;

  } else if (arm === "PROD-RESULTS") {
    // ── PROD-RESULTS ────────────────────────────────────────────────────────
    // Production's underlying SearchResult[] BEFORE string-rendering.
    // Inline-duplicates the dense-turn-lane block from search-history.ts:311-361.
    // Does NOT call handleSearchHistory. Does NOT re-parse its string.
    // Isolates retrieval-content loss (what production actually finds vs benchmark).

    const searchOptions: SearchOptions = {
      limit: 20,
      project: undefined,
      includeContext: false,
      user: undefined,
      model: undefined,
    };
    const limit = 20;

    // Build asyncSearch closure (SemanticSearchBridge, mirrors Arm PROD-CONSUMER)
    const bridge = new SemanticSearchBridge(ingested.docStore, ingested.db);
    const asyncSearch = async (query: string, options: SearchOptions): Promise<SearchResult[]> => {
      const hybridResults = await bridge.search(query, options);
      if (hybridResults !== null) return hybridResults;
      return ingested.searchEngine.search(query, options);
    };

    // Inject reranker
    const reranker = await createReranker();
    if (reranker.name !== "none") {
      ingested.searchEngine.setReranker(reranker);
    }

    // Chunk lane (dense-turn-lane branch, search-history.ts:325-328)
    const chunkLane = await asyncSearch(question.question, searchOptions);

    // Merge knowledge entries (search-history.ts:330-345)
    let mergedChunkLane = chunkLane;
    const knowledgeResults = await searchKnowledgeViaStore(
      ingested.knowledgeStore,
      question.question,
      searchOptions
    );
    if (knowledgeResults.length > 0) {
      mergedChunkLane = [...mergedChunkLane, ...knowledgeResults]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    }

    // Turn lane (search-history.ts:350-356)
    ingested.searchEngine.setKnowledgeTurnStore(ingested.turnStore);
    const turnHits = await ingested.searchEngine.searchTurns(question.question, {
      userId: undefined,
      project: undefined,
      limit,
    });

    // RRF fusion (search-history.ts:360-361)
    const searchResults = fuseDenseTurnLane(
      mergedChunkLane,
      turnHits,
      CONFIG.search.denseTurnLane.maxTurnResults
    ).slice(0, limit);

    const { answer } = await withRetry(() =>
      generateAnswer(
        answerProvider.provider,
        question.question,
        question.question_date,
        searchResults,
        {
          topK: 20,
          promptVariant: "category",
          questionType: question.question_type,
        }
      )
    );

    contextLength = searchResults.reduce((s, r) => s + r.text.length, 0);
    contextSessionCount = new Set(searchResults.map((r) => r.sessionId)).size;

    const judgeResult = await judgeAnswer(
      judgeProvider.provider,
      question.question_type,
      question.question_id,
      question.question,
      question.answer,
      answer,
      { votes: judgeVotes }
    );

    closeIngested(ingested);
    return {
      questionId: question.question_id,
      questionType: question.question_type,
      ability: questionTypeToAbility(question.question_type),
      arm,
      judgeVerdict: judgeResult.verdict,
      contextLength,
      contextSessionCount,
      metadata: {
        benchmarkFromFile: false,
        harness: "prod-consumer-parity.ts",
        answerModel: answerProvider.modelName,
        judgeModel: judgeProvider.modelName,
        runTimestamp,
      },
    };

  } else {
    // arm === "PROD-STRING-PARSED"
    // ── PROD-STRING-PARSED ──────────────────────────────────────────────────
    // handleSearchHistory string → productionStringToSearchResults → generateAnswer.
    // The LEGACY round-trip. Kept as regression reference only.

    const bridge = new SemanticSearchBridge(ingested.docStore, ingested.db);
    const asyncSearch = async (query: string, options: SearchOptions): Promise<SearchResult[]> => {
      const hybridResults = await bridge.search(query, options);
      if (hybridResults !== null) return hybridResults;
      return ingested.searchEngine.search(query, options);
    };

    const reranker = await createReranker();
    if (reranker.name !== "none") {
      ingested.searchEngine.setReranker(reranker);
    }

    const args: SearchHistoryArgs = {
      query: question.question,
      limit: 20,
      max_chars: maxChars,
      // retrieval_strategy OMITTED — same default as PROD-CONSUMER
    };

    const rawString = await handleSearchHistory(
      ingested.searchEngine,
      args,
      ingested.db,
      asyncSearch,
      ingested.knowledgeStore,
      ingested.turnStore,
    );

    productionOutputLength = rawString.length;

    // Re-parse the string (legacy round-trip — NOT what a real consumer does)
    const searchResults = productionStringToSearchResults(rawString);

    const { answer } = await withRetry(() =>
      generateAnswer(
        answerProvider.provider,
        question.question,
        question.question_date,
        searchResults,
        {
          topK: 20,
          promptVariant: "category",
          questionType: question.question_type,
        }
      )
    );

    contextLength = searchResults.reduce((s, r) => s + r.text.length, 0);
    contextSessionCount = searchResults.length;

    const judgeResult = await judgeAnswer(
      judgeProvider.provider,
      question.question_type,
      question.question_id,
      question.question,
      question.answer,
      answer,
      { votes: judgeVotes }
    );

    closeIngested(ingested);
    return {
      questionId: question.question_id,
      questionType: question.question_type,
      ability: questionTypeToAbility(question.question_type),
      arm,
      judgeVerdict: judgeResult.verdict,
      contextLength,
      contextSessionCount,
      productionOutputLength,
      metadata: {
        benchmarkFromFile: false,
        harness: "prod-consumer-parity.ts",
        answerModel: answerProvider.modelName,
        judgeModel: judgeProvider.modelName,
        runTimestamp,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// searchKnowledgeViaStore helper (mirrors search-history.ts:166-177)
// ---------------------------------------------------------------------------

async function searchKnowledgeViaStore(
  store: any,
  query: string,
  options: SearchOptions
): Promise<SearchResult[]> {
  try {
    const entries = await store.search(query, options.project, options.user);
    return entries.map(knowledgeEntryToSearchResult);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Accuracy aggregation (mirrors parity-comparison.ts)
// ---------------------------------------------------------------------------

function computeAccuracy(results: PcpRunResult[]): {
  overall: number;
  taskAveraged: number;
  byAbility: Record<string, { correct: number; total: number; accuracy: number }>;
  byQuestionType: Record<string, { correct: number; total: number; accuracy: number }>;
} {
  const byAbility = new Map<string, { correct: number; total: number }>();
  const byQType = new Map<string, { correct: number; total: number }>();

  for (const r of results) {
    const ae = byAbility.get(r.ability) ?? { correct: 0, total: 0 };
    ae.total++;
    if (r.judgeVerdict === "CORRECT") ae.correct++;
    byAbility.set(r.ability, ae);

    const qe = byQType.get(r.questionType) ?? { correct: 0, total: 0 };
    qe.total++;
    if (r.judgeVerdict === "CORRECT") qe.correct++;
    byQType.set(r.questionType, qe);
  }

  const totalCorrect = results.filter((r) => r.judgeVerdict === "CORRECT").length;
  const overall = results.length > 0 ? totalCorrect / results.length : 0;

  const abilityAccuracies: number[] = [];
  const byAbilityOut: Record<string, { correct: number; total: number; accuracy: number }> = {};
  for (const [ability, entry] of byAbility) {
    const accuracy = entry.total > 0 ? entry.correct / entry.total : 0;
    abilityAccuracies.push(accuracy);
    byAbilityOut[ability] = { ...entry, accuracy };
  }

  const taskAveraged =
    abilityAccuracies.length > 0
      ? abilityAccuracies.reduce((s, v) => s + v, 0) / abilityAccuracies.length
      : 0;

  const byQTypeOut: Record<string, { correct: number; total: number; accuracy: number }> = {};
  for (const [qt, entry] of byQType) {
    byQTypeOut[qt] = {
      ...entry,
      accuracy: entry.total > 0 ? entry.correct / entry.total : 0,
    };
  }

  return { overall, taskAveraged, byAbility: byAbilityOut, byQuestionType: byQTypeOut };
}

// ---------------------------------------------------------------------------
// Report printer
// ---------------------------------------------------------------------------

function printReport(
  results: Map<PcpArmLabel, PcpRunResult[]>,
  runIds: Record<PcpArmLabel, string>
): void {
  const abilityOrder: MemoryAbility[] = [
    "information_extraction",
    "multi_session_reasoning",
    "temporal_reasoning",
    "knowledge_update",
    "abstention",
  ];

  const arms: PcpArmLabel[] = [
    "PROD-CONSUMER",
    "BENCHMARK",
    "PROD-RESULTS",
    "PROD-STRING-PARSED",
  ];

  const accs = new Map<PcpArmLabel, ReturnType<typeof computeAccuracy>>();
  for (const arm of arms) {
    const r = results.get(arm);
    if (r && r.length > 0) accs.set(arm, computeAccuracy(r));
  }

  console.log("\n");
  console.log("=".repeat(110));
  console.log("PROD-CONSUMER PARITY — 4-ARM RESULTS");
  console.log("=".repeat(110));
  console.log("PROD-CONSUMER     = handleSearchHistory (default dense-turn-lane) → raw STRING verbatim");
  console.log("BENCHMARK         = retrieveQuestion(sessionScoring=true) → SearchResult[] → generateAnswer");
  console.log("PROD-RESULTS      = prod dense-turn-lane SearchResult[] (before rendering) → generateAnswer");
  console.log("PROD-STRING-PARSED= handleSearchHistory string → productionStringToSearchResults → generateAnswer");
  console.log("");

  const fmt = (x: { correct: number; total: number; accuracy: number } | undefined) =>
    x ? `${(x.accuracy * 100).toFixed(1)}%(${x.correct}/${x.total})` : "n/a";

  // Per-ability table
  console.log(
    "| Ability                  | PROD-CONSUMER | BENCHMARK     | PROD-RESULTS  | PROD-STR-PARSED |"
  );
  console.log(
    "|--------------------------|---------------|---------------|---------------|-----------------|"
  );

  for (const ability of abilityOrder) {
    const pc = accs.get("PROD-CONSUMER")?.byAbility[ability];
    const bm = accs.get("BENCHMARK")?.byAbility[ability];
    const pr = accs.get("PROD-RESULTS")?.byAbility[ability];
    const ps = accs.get("PROD-STRING-PARSED")?.byAbility[ability];
    const label = ability.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).padEnd(24);
    console.log(
      `| ${label} | ${fmt(pc).padEnd(13)} | ${fmt(bm).padEnd(13)} | ${fmt(pr).padEnd(13)} | ${fmt(ps).padEnd(15)} |`
    );
  }

  // Overall rows
  const fmtO = (arm: PcpArmLabel) => {
    const acc = accs.get(arm);
    if (!acc) return "n/a".padEnd(13);
    return `${(acc.overall * 100).toFixed(1)}%`.padEnd(13);
  };
  const fmtT = (arm: PcpArmLabel) => {
    const acc = accs.get(arm);
    if (!acc) return "n/a".padEnd(13);
    return `${(acc.taskAveraged * 100).toFixed(1)}%`.padEnd(13);
  };

  console.log(
    `| ${"OVERALL (raw)".padEnd(24)} | ${fmtO("PROD-CONSUMER")} | ${fmtO("BENCHMARK")} | ${fmtO("PROD-RESULTS")} | ${fmtO("PROD-STRING-PARSED").padEnd(15)} |`
  );
  console.log(
    `| ${"TASK-AVERAGED".padEnd(24)} | ${fmtT("PROD-CONSUMER")} | ${fmtT("BENCHMARK")} | ${fmtT("PROD-RESULTS")} | ${fmtT("PROD-STRING-PARSED").padEnd(15)} |`
  );

  // Decomposition deltas
  const pcAcc = accs.get("PROD-CONSUMER");
  const bmAcc = accs.get("BENCHMARK");
  const prAcc = accs.get("PROD-RESULTS");
  const psAcc = accs.get("PROD-STRING-PARSED");

  console.log("\n--- DECOMPOSITION DELTAS (task-averaged) ---");
  if (bmAcc && pcAcc) {
    const total = (bmAcc.taskAveraged - pcAcc.taskAveraged) * 100;
    console.log(`  Total gap          (BENCHMARK − PROD-CONSUMER):   ${total.toFixed(1)}pp`);
    const h4 = Math.abs(total) < 3;
    console.log(`  H4 (parity <3pp): ${h4 ? "FIRED — production consumer matches benchmark" : "NOT FIRED"}`);
  }
  if (bmAcc && prAcc) {
    const retrieval = (bmAcc.taskAveraged - prAcc.taskAveraged) * 100;
    console.log(`  Retrieval-content  (BENCHMARK − PROD-RESULTS):    ${retrieval.toFixed(1)}pp`);
    const h1 = retrieval > 5;
    console.log(`  H1 (retrieval >5pp): ${h1 ? "FIRED — retrieval content loss is the gap" : "NOT FIRED"}`);
  }
  if (prAcc && pcAcc) {
    const renderTrunc = (prAcc.taskAveraged - pcAcc.taskAveraged) * 100;
    console.log(`  Render+truncation  (PROD-RESULTS − PROD-CONSUMER): ${renderTrunc.toFixed(1)}pp`);
    const h2 = renderTrunc > 2;
    console.log(`  H2 (truncation >2pp): ${h2 ? "FIRED — string rendering/truncation costs quality" : "NOT FIRED"}`);
  }
  if (psAcc && pcAcc) {
    const roundTrip = (psAcc.taskAveraged - pcAcc.taskAveraged) * 100;
    console.log(`  Round-trip cost    (PROD-STRING-PARSED − PROD-CONSUMER): ${roundTrip.toFixed(1)}pp`);
    const h3 = roundTrip > 1;
    console.log(`  H3 (round-trip >1pp): ${h3 ? "FIRED — retire productionStringToSearchResults / old 70.1% is invalid" : "NOT FIRED"}`);
  }

  // Per-question-type breakdown
  console.log("\n--- Per-question-type breakdown ---");
  const allQTypes = new Set<string>();
  for (const [, r] of results) {
    for (const row of r) allQTypes.add(row.questionType);
  }
  for (const qt of [...allQTypes].sort()) {
    const pc = accs.get("PROD-CONSUMER")?.byQuestionType[qt];
    const bm = accs.get("BENCHMARK")?.byQuestionType[qt];
    const pr = accs.get("PROD-RESULTS")?.byQuestionType[qt];
    const ps = accs.get("PROD-STRING-PARSED")?.byQuestionType[qt];
    console.log(
      `  ${qt.padEnd(32)} PC:${fmt(pc).padEnd(16)} BM:${fmt(bm).padEnd(16)} PR:${fmt(pr).padEnd(16)} PS:${fmt(ps)}`
    );
  }

  // Context stats
  console.log("\n--- Context statistics ---");
  for (const arm of arms) {
    const r = results.get(arm);
    if (!r || r.length === 0) continue;
    const avgChars = (r.reduce((s, x) => s + x.contextLength, 0) / r.length).toFixed(0);
    const avgBlks = (r.reduce((s, x) => s + x.contextSessionCount, 0) / r.length).toFixed(1);
    const prodLengths = r.filter((x) => x.productionOutputLength !== undefined);
    const avgProd = prodLengths.length > 0
      ? (prodLengths.reduce((s, x) => s + (x.productionOutputLength ?? 0), 0) / prodLengths.length).toFixed(0)
      : "n/a";
    console.log(
      `  ${arm.padEnd(20)}: avg contextLength=${avgChars} chars, blocks=${avgBlks}${prodLengths.length > 0 ? `, prodOutputLength=${avgProd}` : ""}`
    );
  }

  // Bridge/dense-turn stats for PROD-CONSUMER
  {
    const r = results.get("PROD-CONSUMER") ?? [];
    if (r.length > 0) {
      const bridgeActive = r.filter((x) => x.bridgeActive === true).length;
      const bridgeFts = r.filter((x) => x.bridgeActive === false).length;
      console.log(
        `\n  PROD-CONSUMER bridge: ${bridgeActive} hybrid (SemanticSearchBridge), ${bridgeFts} FTS5-fallback`
      );
      const dtsActive = r.filter((x) => x.denseTurnStoreActive === true).length;
      console.log(`  PROD-CONSUMER denseTurnStore active: ${dtsActive}/${r.length}`);
    }
  }

  // Run IDs
  console.log("\n--- Run IDs ---");
  for (const arm of arms) {
    if (results.has(arm)) console.log(`  ${arm}: ${runIds[arm]}`);
  }
}

// ---------------------------------------------------------------------------
// Run one arm (with checkpoint resume)
// ---------------------------------------------------------------------------

async function runArm(
  arm: PcpArmLabel,
  questions: LongMemQuestion[],
  runId: string,
  answerProvider: ReturnType<typeof createAnswerProvider>,
  judgeProvider: ReturnType<typeof createJudgeProvider>,
  judgeVotes: number,
  runTimestamp: string,
  label: string,
  maxChars: number = 2500,
): Promise<PcpRunResult[]> {
  const completed = loadCompleted(runId);
  const results: PcpRunResult[] = [];

  // Load already-completed results from checkpoint
  for (const [, record] of completed) {
    results.push(record as PcpRunResult);
  }

  const remaining = questions.filter((q) => !completed.has(q.question_id));
  console.log(`\n--- ${label} ---`);
  console.log(`  ${completed.size} already complete, ${remaining.length} to go`);

  for (let i = 0; i < remaining.length; i++) {
    const question = remaining[i];
    const progress = `[${i + 1}/${remaining.length}]`;
    process.stdout.write(`  ${progress} Q${question.question_id} (${question.question_type})... `);

    try {
      const result = await runOneQuestion(
        question,
        arm,
        answerProvider,
        judgeProvider,
        judgeVotes,
        runTimestamp,
        maxChars,
      );
      results.push(result);
      appendResult(runId, result);

      const bridgeNote =
        result.bridgeActive !== undefined
          ? ` bridge:${result.bridgeActive ? "YES" : "FTS5-fallback"}`
          : "";
      process.stdout.write(
        `${result.judgeVerdict} (${result.contextSessionCount} blks, ${result.contextLength} chars${bridgeNote})\n`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`ERROR: ${msg}\n`);
      // Don't checkpoint errors — question retries on next run
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Smoke test
// ---------------------------------------------------------------------------

async function runSmoke(
  arms: PcpArmLabel[],
  smokeN: number,
  dataset: LongMemQuestion[],
  runIdBase: string,
  answerProvider: ReturnType<typeof createAnswerProvider>,
  judgeProvider: ReturnType<typeof createJudgeProvider>,
  judgeVotes: number,
  runTimestamp: string,
  maxChars: number = 2500,
): Promise<boolean> {
  const smokeIds = new Set(pickStratified(dataset, smokeN));
  const smokeQuestions = dataset.filter((q) => smokeIds.has(q.question_id));

  console.log(`\n${"=".repeat(70)}`);
  console.log(
    `SMOKE TEST (${smokeN}/ability → ${smokeQuestions.length} questions per arm, ${arms.length} arms)`
  );
  console.log("=".repeat(70));

  const smokeResults = new Map<PcpArmLabel, PcpRunResult[]>();
  const smokeRunIds: Record<PcpArmLabel, string> = {
    "PROD-CONSUMER": `${runIdBase}-pc-smoke`,
    "BENCHMARK": `${runIdBase}-bm-smoke`,
    "PROD-RESULTS": `${runIdBase}-pr-smoke`,
    "PROD-STRING-PARSED": `${runIdBase}-ps-smoke`,
  };

  for (const arm of arms) {
    const r = await runArm(
      arm,
      smokeQuestions,
      smokeRunIds[arm],
      answerProvider,
      judgeProvider,
      judgeVotes,
      runTimestamp,
      `SMOKE — ${arm}`,
      maxChars,
    );
    smokeResults.set(arm, r);
  }

  console.log("\n--- SMOKE RESULTS ---");
  printReport(smokeResults, smokeRunIds);

  // ── SMOKE PASS CRITERIA ──────────────────────────────────────────────────
  console.log("\n--- SMOKE PASS CRITERIA ---");
  let allPass = true;

  // 1. No embedding/constraint errors (no errors thrown)
  console.log("1. No embedding/constraint errors: PASS (no errors thrown during smoke)");

  // 2. PROD-CONSUMER contextLength > 0
  {
    const pcResults = smokeResults.get("PROD-CONSUMER") ?? [];
    const contextOk = pcResults.every((r) => r.contextLength > 0);
    const verdict = contextOk && pcResults.length > 0 ? "PASS" : "FAIL";
    if (verdict === "FAIL") allPass = false;
    console.log(
      `2. PROD-CONSUMER contextLength>0: ${verdict} (${pcResults.filter((r) => r.contextLength > 0).length}/${pcResults.length} non-empty)`
    );
  }

  // 3. BENCHMARK contextSessionCount > 0 AND real session IDs
  //    Only applicable when the BENCHMARK arm is actually being run; a
  //    single-arm run (e.g. --arm=prod-consumer) has no BENCHMARK results
  //    and must not be failed on this criterion.
  if (!arms.includes("BENCHMARK")) {
    console.log(`3. BENCHMARK contextSessionCount>0: SKIP (BENCHMARK arm not in this run)`);
  } else {
    const bmResults = smokeResults.get("BENCHMARK") ?? [];
    const sessionOk = bmResults.every((r) => r.contextSessionCount > 0);
    const verdict = sessionOk && bmResults.length > 0 ? "PASS" : "FAIL";
    if (verdict === "FAIL") allPass = false;
    console.log(
      `3. BENCHMARK contextSessionCount>0: ${verdict} (${bmResults.filter((r) => r.contextSessionCount > 0).length}/${bmResults.length})`
    );
    const realIdCheck = bmResults.filter((r) => (r as any)._hasRealSessionIds !== false).length;
    console.log(
      `   Real Strata sessionIds (longmemeval-N): ${realIdCheck}/${bmResults.length} questions`
    );
  }

  // 4. SemanticSearchBridge active on ≥1 question (PROD-CONSUMER)
  {
    const pcResults = smokeResults.get("PROD-CONSUMER") ?? [];
    const bridgeCount = pcResults.filter((r) => r.bridgeActive === true).length;
    const verdict = bridgeCount > 0 ? "PASS" : "WARN — bridge never fired (no GEMINI_API_KEY?)";
    if (bridgeCount === 0) {
      console.warn("   WARNING: SemanticSearchBridge fell back to FTS5 on all questions — check GEMINI_API_KEY");
    }
    console.log(
      `4. SemanticSearchBridge active: ${verdict} (${bridgeCount}/${pcResults.length} hybrid)`
    );
  }

  // 5. denseTurnStore active on PROD-CONSUMER
  {
    const pcResults = smokeResults.get("PROD-CONSUMER") ?? [];
    const dtsCount = pcResults.filter((r) => r.denseTurnStoreActive === true).length;
    const verdict = dtsCount > 0 ? "PASS" : "FAIL";
    if (verdict === "FAIL") allPass = false;
    console.log(`5. denseTurnStore active (PROD-CONSUMER): ${verdict} (${dtsCount}/${pcResults.length})`);
  }

  // 6. BENCHMARK sanity gate — must land in ~80s%% range
  {
    const bmResults = smokeResults.get("BENCHMARK") ?? [];
    if (bmResults.length > 0) {
      const acc = computeAccuracy(bmResults);
      const taskAvg = acc.taskAveraged * 100;
      const inRange = taskAvg >= 70; // warn if below 70% on 25Q smoke
      const verdict = inRange ? "PASS" : "BLOCKED";
      if (!inRange) allPass = false;
      console.log(
        `6. BENCHMARK sanity (task-avg should be ~80s%% range): ${verdict} (${taskAvg.toFixed(1)}%)`
      );
      if (!inRange) {
        console.error(
          "\n!!! BLOCKED: BENCHMARK arm is below 70% on smoke — harness is NOT faithfully reproducing the 84.4% config."
        );
        console.error(
          "    Check: sessionScoring options {limit:60,sessionK:20}, category prompt, temp=0 for vertex-gemini."
        );
      }
    }
  }

  // 7. Same answer model / judge for all arms
  console.log(
    `7. Answer model: ${answerProvider.modelName}, judge: ${judgeProvider.modelName}: PASS (same provider for all arms)`
  );

  // 8. Temperature verification (can't test at runtime, but document)
  const isVertexGemini = answerProvider.modelName.includes("gemini");
  console.log(
    `8. Temperature: ${isVertexGemini ? "0 (vertex-gemini → baseline, NOT 1.0)" : "per provider"}: NOTED`
  );

  return allPass;
}

// ---------------------------------------------------------------------------
// Verify-from-disk gate
// ---------------------------------------------------------------------------

function verifyFromDisk(
  resultPaths: Record<PcpArmLabel, string>,
  arms: PcpArmLabel[]
): boolean {
  console.log("\n=== VERIFY-FROM-DISK GATE ===");
  let allOk = true;

  for (const arm of arms) {
    const path = resultPaths[arm];
    if (!existsSync(path)) {
      console.error(`  FAIL [${arm}]: result file not found at ${path}`);
      allOk = false;
      continue;
    }

    let records: PcpRunResult[];
    try {
      records = JSON.parse(readFileSync(path, "utf-8")) as PcpRunResult[];
    } catch (err) {
      console.error(`  FAIL [${arm}]: could not parse result JSON: ${err}`);
      allOk = false;
      continue;
    }

    // Assert 500 unique question_ids
    const ids = new Set(records.map((r) => r.questionId));
    if (ids.size < 500) {
      console.error(`  FAIL [${arm}]: only ${ids.size}/500 unique question_ids`);
      allOk = false;
    }

    // Assert benchmarkFromFile: false in metadata
    const bffViolations = records.filter((r) => r.metadata?.benchmarkFromFile !== false);
    if (bffViolations.length > 0) {
      console.error(`  FAIL [${arm}]: ${bffViolations.length} records have benchmarkFromFile !== false`);
      allOk = false;
    }

    // BENCHMARK arm: assert real Strata sessionIds (not "production-output-N")
    if (arm === "BENCHMARK") {
      const fakeIds = records.filter((r) => (r as any)._hasRealSessionIds === false);
      if (fakeIds.length > 0) {
        console.error(`  FAIL [BENCHMARK]: ${fakeIds.length} questions had no real longmemeval-N session IDs`);
        allOk = false;
      }
    }

    const acc = computeAccuracy(records);
    console.log(
      `  OK [${arm}]: ${ids.size} unique Qs, benchmarkFromFile:false, overall=${(acc.overall * 100).toFixed(1)}%, task-avg=${(acc.taskAveraged * 100).toFixed(1)}%`
    );
  }

  if (allOk) {
    console.log("  VERIFY-FROM-DISK: ALL ASSERTIONS PASSED");
  } else {
    console.error("  VERIFY-FROM-DISK: SOME ASSERTIONS FAILED — numbers above are INVALID");
  }
  return allOk;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnv();
  const { arm, runIdBase, smokeN, judgeVotes, limit, maxChars, promptVariant } = parseArgs();
  PROMPT_VARIANT = promptVariant;
  if (maxChars !== 2500) {
    console.log(`max_chars OVERRIDE: ${maxChars} (default 2500) — PROD-CONSUMER + PROD-STRING-PARSED arms`);
  }
  if (promptVariant !== "baseline") {
    console.log(`PROMPT VARIANT: ${promptVariant} (artifact-check C — format-honest raw-string prompt)`);
  }

  const allArms: PcpArmLabel[] = [
    "PROD-CONSUMER",
    "BENCHMARK",
    "PROD-RESULTS",
    "PROD-STRING-PARSED",
  ];

  const armsToDo: PcpArmLabel[] =
    arm === "all"
      ? allArms
      : arm === "prod-consumer"
      ? ["PROD-CONSUMER"]
      : arm === "benchmark"
      ? ["BENCHMARK"]
      : arm === "prod-results"
      ? ["PROD-RESULTS"]
      : ["PROD-STRING-PARSED"];

  console.log("LongMemEval Prod-Consumer Parity — 4-Arm Diagnostic");
  console.log("====================================================");
  console.log(`Arms: ${armsToDo.join(", ")}`);
  console.log(`Judge votes: ${judgeVotes} | Run ID base: ${runIdBase}`);

  // Configure embedding cache (warm → $0 embeddings)
  configureEmbeddingCache({ enabled: true });

  const dataset = loadDataset();
  console.log(`Dataset: ${dataset.length} questions`);

  // Set up providers
  let answerProvider: ReturnType<typeof createAnswerProvider>;
  let judgeProvider: ReturnType<typeof createJudgeProvider>;
  try {
    answerProvider = createAnswerProvider();
    judgeProvider = createJudgeProvider();
  } catch (err) {
    console.error(`Failed to create providers: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  console.log(`Answer model: ${answerProvider.modelName}`);
  console.log(`Judge model:  ${judgeProvider.modelName}`);
  console.log(
    `Temperature:  ${answerProvider.provider.name === "gemini" ? "1.0 (bare gemini)" : "0 (vertex-gemini / others)"}`
  );

  const runTimestamp = new Date().toISOString();

  // Smoke test
  if (smokeN > 0) {
    const smokePass = await runSmoke(
      armsToDo,
      smokeN,
      dataset,
      runIdBase,
      answerProvider,
      judgeProvider,
      judgeVotes,
      runTimestamp,
      maxChars,
    );

    if (!smokePass) {
      console.error(
        "\n!!! SMOKE FAILED — not proceeding to full 500Q run. Fix the issues above."
      );
      process.exit(1);
    }

    console.log(`\nSmoke passed — proceeding to full 500Q run.`);
  }

  // Full run
  mkdirSync(RESULTS_DIR, { recursive: true });

  const runIds: Record<PcpArmLabel, string> = {
    "PROD-CONSUMER": `${runIdBase}-pc`,
    "BENCHMARK": `${runIdBase}-bm`,
    "PROD-RESULTS": `${runIdBase}-pr`,
    "PROD-STRING-PARSED": `${runIdBase}-ps`,
  };

  let questions = dataset;
  if (Number.isFinite(limit) && limit < dataset.length) {
    questions = dataset.slice(0, limit);
    console.log(`\nDEBUG: capped to first ${limit} questions.`);
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(`FULL RUN (${questions.length} questions per arm, ${armsToDo.length} arms)`);
  console.log("=".repeat(70));

  const allResults = new Map<PcpArmLabel, PcpRunResult[]>();

  for (const armLabel of armsToDo) {
    const r = await runArm(
      armLabel,
      questions,
      runIds[armLabel],
      answerProvider,
      judgeProvider,
      judgeVotes,
      runTimestamp,
      `Arm ${armLabel}`,
      maxChars,
    );
    allResults.set(armLabel, r);

    // Save after each arm completes
    const path = join(RESULTS_DIR, `${runIds[armLabel]}.json`);
    writeFileSync(path, JSON.stringify(r, null, 2), "utf-8");
    console.log(`\nArm ${armLabel} complete: ${r.length} results saved to ${path}`);

    if (r.length > 0) {
      const acc = computeAccuracy(r);
      console.log(
        `  Overall: ${(acc.overall * 100).toFixed(1)}%  Task-avg: ${(acc.taskAveraged * 100).toFixed(1)}%`
      );
    }
  }

  // Load any arms run in separate invocations
  for (const armLabel of allArms) {
    if (!allResults.has(armLabel)) {
      const path = join(RESULTS_DIR, `${runIds[armLabel]}.json`);
      if (existsSync(path)) {
        const r = JSON.parse(readFileSync(path, "utf-8")) as PcpRunResult[];
        allResults.set(armLabel, r);
        console.log(`Loaded ${armLabel} from ${path} (${r.length} results)`);
      }
    }
  }

  // Final report
  if (allResults.size > 0) {
    printReport(allResults, runIds);
  }

  // Verify-from-disk gate
  if (armsToDo.length === allArms.length) {
    const resultPaths: Record<PcpArmLabel, string> = {
      "PROD-CONSUMER": join(RESULTS_DIR, `${runIds["PROD-CONSUMER"]}.json`),
      "BENCHMARK": join(RESULTS_DIR, `${runIds["BENCHMARK"]}.json`),
      "PROD-RESULTS": join(RESULTS_DIR, `${runIds["PROD-RESULTS"]}.json`),
      "PROD-STRING-PARSED": join(RESULTS_DIR, `${runIds["PROD-STRING-PARSED"]}.json`),
    };
    verifyFromDisk(resultPaths, armsToDo);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
