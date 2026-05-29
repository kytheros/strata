/**
 * LongMemEval Judge Scoring
 *
 * Ports the official judge prompts from the LongMemEval Python eval script
 * (src/evaluation/evaluate_qa.py in xiaowu0162/LongMemEval).
 *
 * Adapts prompts per-model following each vendor's best practices:
 *
 * - **Anthropic (Claude)**: Per Anthropic's eval docs, encourage reasoning
 *   in <thinking> tags then extract verdict from <result> tags. This increases
 *   evaluation performance over suppressing reasoning.
 *   Source: https://docs.anthropic.com/en/docs/test-and-evaluate/develop-tests
 *
 * - **Gemini**: Structured output with clear verdict extraction.
 *
 * - **OpenAI (GPT-4o)**: Original prompts verbatim — "Answer yes or no only."
 *   This is the baseline judge used by the LongMemEval paper and all published
 *   scores (OMEGA 95.4%, Hindsight 91.4%, Zep 71.2%).
 *
 * Since published scores use GPT-4o, scores from alternative judges are not
 * directly comparable. The calibration study (run-calibration.ts) measures
 * inter-judge agreement to quantify this difference.
 */

import type { LlmProvider } from "../../src/extensions/llm-extraction/llm-provider.js";
import type { QuestionType } from "./types.js";
import { withRetry } from "./answer.js";

// ---------------------------------------------------------------------------
// Official prompt templates (verbatim from LongMemEval evaluate_qa.py)
// These are the CORE evaluation criteria — model-specific wrappers go around them.
// ---------------------------------------------------------------------------

const EVAL_CRITERIA: Record<string, string> = {
  // Standard QA: single-session-user, single-session-assistant, multi-session
  standard: [
    "I will give you a question, a correct answer, and a response from a model.",
    "Please answer yes if the response contains the correct answer. Otherwise, answer no.",
    "If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes.",
    "If the response only contains a subset of the information required by the answer, answer no.",
  ].join(" "),

  // Temporal reasoning: allows off-by-one errors for day counts
  "temporal-reasoning": [
    "I will give you a question, a correct answer, and a response from a model.",
    "Please answer yes if the response contains the correct answer. Otherwise, answer no.",
    "If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes.",
    "If the response only contains a subset of the information required by the answer, answer no.",
    "In addition, do not penalize off-by-one errors for the number of days.",
    "If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct.",
  ].join(" "),

  // Knowledge update: accepts previous info alongside updated answer
  "knowledge-update": [
    "I will give you a question, a correct answer, and a response from a model.",
    "Please answer yes if the response contains the correct answer. Otherwise, answer no.",
    "If the response contains some previous information along with an updated answer,",
    "the response should be considered as correct as long as the updated answer is the required answer.",
  ].join(" "),

  // Preference: rubric-based evaluation
  "single-session-preference": [
    "I will give you a question, a rubric for desired personalized response, and a response from a model.",
    "Please answer yes if the response satisfies the desired response. Otherwise, answer no.",
    "The model does not need to reflect all the points in the rubric.",
    "The response is correct as long as it recalls and utilizes the user's personal information correctly.",
  ].join(" "),

  // Unanswerable / abstention
  unanswerable: [
    "I will give you an unanswerable question, an explanation, and a response from a model.",
    "Please answer yes if the model correctly identifies the question as unanswerable.",
    "The model could say that the information is incomplete,",
    "or some other information is given but the asked information is not.",
  ].join(" "),
};

// ---------------------------------------------------------------------------
// Model-specific prompt builders
// ---------------------------------------------------------------------------

/**
 * Build the evidence block (question + answer + response) for the judge.
 * The label for the answer field varies by question type per the official script.
 */
function buildEvidenceBlock(
  questionType: QuestionType,
  question: string,
  goldAnswer: string,
  predictedAnswer: string
): string {
  const answerLabel =
    questionType === "single-session-preference"
      ? "Rubric"
      : questionType === "unanswerable"
        ? "Explanation"
        : "Correct Answer";

  return [
    `Question: ${question}`,
    "",
    `${answerLabel}: ${goldAnswer}`,
    "",
    `Model Response: ${predictedAnswer}`,
  ].join("\n");
}

/**
 * Anthropic (Claude) prompt — follows Anthropic's eval best practices:
 * "Encourage reasoning: Ask the LLM to think first before deciding an
 *  evaluation score, and then discard the reasoning."
 *
 * Uses <thinking> tags for reasoning and <result> tags for the verdict.
 * Source: https://docs.anthropic.com/en/docs/test-and-evaluate/develop-tests#grading-evals
 */
function buildAnthropicPrompt(
  criteria: string,
  evidence: string,
  questionType: QuestionType
): string {
  const verdictQuestion =
    questionType === "unanswerable"
      ? "Does the model correctly identify the question as unanswerable?"
      : "Is the model response correct?";

  return [
    criteria,
    "",
    evidence,
    "",
    `${verdictQuestion}`,
    "",
    `Think through your reasoning in <thinking> tags, then output 'yes' or 'no' in <result> tags.`,
  ].join("\n");
}

/**
 * Gemini prompt — structured with clear verdict extraction.
 */
function buildGeminiPrompt(
  criteria: string,
  evidence: string,
  questionType: QuestionType
): string {
  const verdictQuestion =
    questionType === "unanswerable"
      ? "Does the model correctly identify the question as unanswerable?"
      : "Is the model response correct?";

  return [
    criteria,
    "",
    evidence,
    "",
    `${verdictQuestion}`,
    "",
    "First briefly explain your reasoning, then on a new line write VERDICT: yes or VERDICT: no",
  ].join("\n");
}

/**
 * OpenAI (GPT-4o) prompt — verbatim from the official LongMemEval eval script.
 * This produces scores directly comparable to all published benchmarks.
 */
function buildOpenAIPrompt(
  criteria: string,
  evidence: string,
  questionType: QuestionType
): string {
  const verdictQuestion =
    questionType === "unanswerable"
      ? "Does the model correctly identify the question as unanswerable? Answer yes or no only."
      : "Is the model response correct? Answer yes or no only.";

  return [criteria, "", evidence, "", verdictQuestion].join("\n");
}

// ---------------------------------------------------------------------------
// Prompt selection and verdict parsing
// ---------------------------------------------------------------------------

/** Select the evaluation criteria based on question type */
function selectCriteria(
  questionType: QuestionType,
  questionId: number | string
): string {
  if (String(questionId).includes("_abs") || questionType === "unanswerable") {
    return EVAL_CRITERIA.unanswerable;
  }
  return EVAL_CRITERIA[questionType] || EVAL_CRITERIA.standard;
}

/** Build the full judge prompt, adapted to the provider's best practices */
function buildJudgePrompt(
  providerName: string,
  questionType: QuestionType,
  questionId: number | string,
  question: string,
  goldAnswer: string,
  predictedAnswer: string
): string {
  const effectiveType: QuestionType =
    String(questionId).includes("_abs") ? "unanswerable" : questionType;
  const criteria = selectCriteria(questionType, questionId);
  const evidence = buildEvidenceBlock(
    effectiveType,
    question,
    goldAnswer,
    predictedAnswer
  );

  switch (providerName) {
    case "anthropic":
      return buildAnthropicPrompt(criteria, evidence, effectiveType);
    case "gemini":
      return buildGeminiPrompt(criteria, evidence, effectiveType);
    default:
      // OpenAI or unknown — use official verbatim format
      return buildOpenAIPrompt(criteria, evidence, effectiveType);
  }
}

/**
 * Parse the judge's response to extract a yes/no verdict.
 * Handles each provider's expected response format.
 */
function parseVerdict(
  rawResponse: string,
  providerName: string
): "CORRECT" | "INCORRECT" {
  const cleaned = rawResponse.trim();
  const lower = cleaned.toLowerCase();

  // Anthropic: extract from <result> tags
  if (providerName === "anthropic") {
    const resultMatch = cleaned.match(/<result>\s*(yes|no)\s*<\/result>/i);
    if (resultMatch) {
      return resultMatch[1].toLowerCase() === "yes" ? "CORRECT" : "INCORRECT";
    }
    // Fallback: Claude may not always use tags perfectly
  }

  // Gemini: extract from VERDICT: line
  if (providerName === "gemini") {
    const verdictMatch = lower.match(/verdict:\s*(yes|no)/i);
    if (verdictMatch) {
      return verdictMatch[1].toLowerCase() === "yes" ? "CORRECT" : "INCORRECT";
    }
    // Fallback
  }

  // Universal fallback (also handles OpenAI's terse responses)
  // 1. Check if response is just "yes" or "no"
  if (lower === "yes" || lower === "yes.") return "CORRECT";
  if (lower === "no" || lower === "no.") return "INCORRECT";

  // 2. Check first word
  const firstWord = lower.split(/[\s.,;:!]/)[0];
  if (firstWord === "yes") return "CORRECT";
  if (firstWord === "no") return "INCORRECT";

  // 3. Official script fallback: `'yes' in response.lower()`
  return lower.includes("yes") ? "CORRECT" : "INCORRECT";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Options for judgeAnswer. */
export interface JudgeOptions {
  /** Number of judge calls per question. Default 1 (back-compat). Recommended 3 or 5. */
  votes?: number;
}

/** Per-call breakdown when votes > 1. */
export interface JudgeVoteBreakdown {
  correct: number;
  incorrect: number;
  rawResponses: string[];
}

/** Return type of judgeAnswer. */
export interface JudgeResult {
  verdict: "CORRECT" | "INCORRECT";
  rawResponse: string;
  latencyMs: number;
  /** Present only when votes > 1. */
  voteBreakdown?: JudgeVoteBreakdown;
}

/**
 * Judge a single answer. Returns CORRECT or INCORRECT.
 *
 * The prompt is adapted to the provider's best practices:
 * - Anthropic: reasoning in <thinking>, verdict in <result> tags
 * - Gemini: reasoning then VERDICT: yes/no line
 * - OpenAI: "Answer yes or no only" (official LongMemEval format)
 *
 * When options.votes > 1, fires N parallel judge calls via Promise.allSettled
 * and returns the majority verdict. Transient failures on individual calls
 * are dropped (N-1 votes used). Per-call rawResponses are surfaced via
 * voteBreakdown for post-hoc audit.
 *
 * Default votes=1 is fully back-compat — no voteBreakdown, same return shape.
 * Recommended: votes=3 for any "real" benchmark result (collapses GPT-4o
 * judge nondeterminism). See specs/2026-05-29-eval-methodology-judge-noise-design.md.
 */
export async function judgeAnswer(
  provider: LlmProvider,
  questionType: QuestionType,
  questionId: number | string,
  question: string,
  goldAnswer: string,
  predictedAnswer: string,
  options: JudgeOptions = {}
): Promise<JudgeResult> {
  const votes = Math.max(1, options.votes ?? 1);

  const prompt = buildJudgePrompt(
    provider.name,
    questionType,
    questionId,
    question,
    goldAnswer,
    predictedAnswer
  );

  // Anthropic/Gemini prompts include reasoning before verdict — need more tokens
  // OpenAI "yes or no only" prompt works fine with 10 tokens
  const maxTokens = provider.name === "openai" ? 10 : 256;

  const start = performance.now();

  // Fire all N calls in parallel. Each is wrapped in withRetry, but failures
  // are swallowed at the vote level so one bad call doesn't sink the question.
  const callResults = await Promise.allSettled(
    Array.from({ length: votes }, () =>
      withRetry(() =>
        provider.complete(prompt, {
          maxTokens,
          temperature: 0,
          timeoutMs: 120000,
        })
      )
    )
  );

  const latencyMs = performance.now() - start;

  // Collect successful responses.
  const successful = callResults
    .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
    .map((r) => r.value);

  if (successful.length === 0) {
    // All calls failed; make one final synchronous attempt for diagnostics.
    const rawResponse = await provider.complete(prompt, {
      maxTokens,
      temperature: 0,
      timeoutMs: 120000,
    });
    const verdict = parseVerdict(rawResponse, provider.name);
    return { verdict, rawResponse: rawResponse.trim(), latencyMs };
  }

  const parsedVerdicts = successful.map((r) => parseVerdict(r, provider.name));
  const correctCount = parsedVerdicts.filter((v) => v === "CORRECT").length;
  const incorrectCount = parsedVerdicts.length - correctCount;

  // Single-vote back-compat: no breakdown, simple return.
  if (votes === 1) {
    return {
      verdict: parsedVerdicts[0],
      rawResponse: successful[0].trim(),
      latencyMs,
    };
  }

  // Majority vote. Tie (only at even N) breaks with the first response.
  let majority: "CORRECT" | "INCORRECT";
  if (correctCount > incorrectCount) {
    majority = "CORRECT";
  } else if (incorrectCount > correctCount) {
    majority = "INCORRECT";
  } else {
    majority = parsedVerdicts[0]; // first-vote-wins on ties (documented bias)
  }

  return {
    verdict: majority,
    rawResponse: successful[0].trim(),
    latencyMs,
    voteBreakdown: {
      correct: correctCount,
      incorrect: incorrectCount,
      rawResponses: successful.map((r) => r.trim()),
    },
  };
}
