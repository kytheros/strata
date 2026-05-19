import type { RetrievalStrategy } from "./retrieval-strategies.js";

export type { RetrievalStrategy };

export type FailureMode =
  | "compound"
  | "hedge"
  | "negation"
  | "temporal"
  | "coreference"
  | "long_context"
  | "code_identifier"
  | "tool_output_buried";

export type LongMemEvalTaskType = "ie" | "ku" | "temporal" | "multi_session";

export interface FixtureTurn {
  role: "user" | "assistant";
  content: string;
}

export interface FixtureSession {
  id: string;
  /**
   * Optional epoch-ms timestamp. Used by recency-aware retrieval strategies.
   * When absent, the harness synthesizes a value based on the session's index
   * in Fixture.sessions[] (see pipeline-driver SYNTHETIC_BASE_MS +
   * SYNTHETIC_SESSION_GAP_MS).
   *
   * Turn-level granularity: all turns in the session share this base
   * createdAt + msgIdx * 1ms so turn order is a stable secondary sort.
   *
   * Spec: 2026-05-18-temporal-retrieval-intervention §6a.
   */
  created_at?: number;
  turns: FixtureTurn[];
}

export interface ExpectedEvidenceTurn {
  session_id: string;
  turn_index: number;
}

export interface Fixture {
  id: string;
  source: "hand-annotated" | "longmemeval";
  failure_mode: FailureMode | null;
  longmemeval_task_type: LongMemEvalTaskType | null;
  sessions: FixtureSession[];
  query: string;
  expected_answer: string;
  expected_evidence_turns: ExpectedEvidenceTurn[];
  min_recall_at_k: number;
  /**
   * Optional per-fixture override. When absent, run-eval falls back to
   * failureModeToStrategy(failure_mode, longmemeval_task_type).
   * Spec: 2026-05-18-distillation-e2e-harness-v2-design.md §4.2.
   */
  retrieval_strategy?: RetrievalStrategy;
}
