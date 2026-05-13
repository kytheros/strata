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
}
