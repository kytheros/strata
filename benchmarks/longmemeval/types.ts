/**
 * LongMemEval Benchmark Types
 *
 * TypeScript interfaces for the LongMemEval dataset (ICLR 2025)
 * and Strata benchmark results.
 *
 * Dataset: https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned
 * Paper: https://arxiv.org/abs/2410.10813
 */

// ---------------------------------------------------------------------------
// Dataset types (match HuggingFace JSON schema)
// ---------------------------------------------------------------------------

/** A single turn in a conversation session */
export interface LongMemTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * In the dataset, sessions are stored as parallel arrays:
 *   haystack_sessions: LongMemTurn[][]   — each session is an array of turns
 *   haystack_session_ids: string[]        — session IDs (e.g., "sharegpt_yywfIrx_0")
 *   haystack_dates: string[]              — dates (e.g., "2023/05/20 (Sat) 02:21")
 */

/** Question types corresponding to the 5 memory abilities */
export type QuestionType =
  | "single-session-user"
  | "single-session-assistant"
  | "single-session-preference"
  | "multi-session"
  | "knowledge-update"
  | "temporal-reasoning"
  | "unanswerable";

/** The 5 high-level memory ability categories */
export type MemoryAbility =
  | "information_extraction"
  | "multi_session_reasoning"
  | "temporal_reasoning"
  | "knowledge_update"
  | "abstention";

/** Map question_type to ability category */
export function questionTypeToAbility(qt: QuestionType): MemoryAbility {
  switch (qt) {
    case "single-session-user":
    case "single-session-assistant":
    case "single-session-preference":
      return "information_extraction";
    case "multi-session":
      return "multi_session_reasoning";
    case "temporal-reasoning":
      return "temporal_reasoning";
    case "knowledge-update":
      return "knowledge_update";
    case "unanswerable":
      return "abstention";
  }
}

/** A single question-history pair from the dataset */
export interface LongMemQuestion {
  question_id: string;
  question_type: QuestionType;
  question: string;
  answer: string;
  question_date: string;
  /** Each session is an array of turns */
  haystack_sessions: LongMemTurn[][];
  /** Parallel array of session IDs */
  haystack_session_ids: string[];
  /** Parallel array of session dates */
  haystack_dates: string[];
  /** IDs of sessions containing the answer evidence */
  answer_session_ids: string[];
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Retrieval result for a single question */
export interface RetrievalResult {
  questionId: string;
  questionType: QuestionType;
  ability: MemoryAbility;
  retrievedSessionIds: string[];
  goldSessionIds: string[];
  evidenceRecall5: number;
  evidenceRecall10: number;
  evidenceRecall20: number;
  mrr: number;
  latencyMs: number;
  /**
   * Recall@K computed against the turn-lane retrieval pass (engine.searchTurns).
   * Populated only when the harness ran the side-by-side turn-lane retrieval
   * (spec 2026-05-25-unified-turn-lane-surface §3.3). Undefined for older
   * results or for harness runs that skipped the turn lane.
   */
  turnRecallAtK?: number;
}

/** Answer + judge result for a single question */
export interface AnswerResult {
  questionId: string;
  questionType: QuestionType;
  ability: MemoryAbility;
  question: string;
  goldAnswer: string;
  predictedAnswer: string;
  judgeVerdict: "CORRECT" | "INCORRECT";
  judgeRawResponse: string;
  answerModel: string;
  judgeModel: string;
  answerLatencyMs: number;
  judgeLatencyMs: number;
  /** Per-judge-call breakdown when judgeVotes > 1; absent for single-vote runs. */
  voteBreakdown?: {
    correct: number;
    incorrect: number;
    rawResponses: string[];
  };
  /**
   * Whether gap-coverage fired (gap-judge returned insufficient) on this question.
   * Present only when --gap-coverage flag was active; absent in flag-off runs.
   */
  gapCoverageFired?: boolean;
  /**
   * Number of new (not originally retrieved) chunks found during gap re-retrieval.
   * Present only when --gap-coverage flag was active; absent in flag-off runs.
   */
  gapNewChunkCount?: number;

  // ── Retrieval fields ─────────────────────────────────────────────────────
  // Mirrored from RetrievalResult so a single perQuestion record is self-
  // contained for offline failure analysis without requiring a re-run.
  // Present when the harness ran the retrieval phase; absent on records
  // restored from checkpoints written before this change.

  /** Ordered list of LongMemEval session IDs returned by the retrieval pass. */
  retrievedSessionIds?: string[];
  /** Gold session IDs the question expects to be retrieved. */
  goldSessionIds?: string[];
  /** Fraction of gold sessions in top-5 retrieved. */
  evidenceRecall5?: number;
  /** Fraction of gold sessions in top-10 retrieved. */
  evidenceRecall10?: number;
  /** Fraction of gold sessions in top-20 retrieved. */
  evidenceRecall20?: number;
  /** Mean Reciprocal Rank of first gold session in retrieved list. */
  mrr?: number;
  /** Retrieval latency in milliseconds. */
  retrievalLatencyMs?: number;
  /**
   * Recall@K from the turn-lane retrieval pass.
   * Present only when the turn-lane side-by-side diagnostic ran.
   */
  turnRecallAtK?: number;
}

/** Per-ability accuracy breakdown */
export interface AbilityScore {
  ability: MemoryAbility;
  correct: number;
  total: number;
  accuracy: number;
}

/** End-to-end latency block (mean + percentiles in ms) */
export interface LatencyBlock {
  meanMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
}

/** Complete benchmark results */
export interface BenchmarkResults {
  variant: "s" | "m";
  searchMode: "bm25" | "hybrid";
  timestamp: string;
  numQuestions: number;
  retrieval: {
    evidenceRecall5: number;
    evidenceRecall10: number;
    evidenceRecall20: number;
    mrr: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
  };
  /** Answer-model latency aggregated across questions. Present only when
   *  the harness ran the answer phase (i.e., not --retrieval-only). */
  answerLatency?: LatencyBlock;
  /** Judge latency aggregated across questions. Same condition as above. */
  judgeLatency?: LatencyBlock;
  accuracy: {
    raw: number;
    rawCount: number;
    taskAveraged: number;
    byAbility: AbilityScore[];
  };
  models: {
    answerModel: string;
    judgeModel: string;
  };
  perQuestion: Array<RetrievalResult & AnswerResult>;
}

/** Calibration result comparing two judges */
export interface CalibrationResult {
  sampleSize: number;
  judge1Model: string;
  judge2Model: string;
  agreementRate: number;
  cohensKappa: number;
  byAbility: Array<{
    ability: MemoryAbility;
    agreementRate: number;
    total: number;
  }>;
}
