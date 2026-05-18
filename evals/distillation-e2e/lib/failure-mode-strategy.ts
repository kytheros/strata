/**
 * failure-mode-strategy.ts — Phase 7.2 (v2 harness)
 *
 * Lookup table from FailureMode / LongMemEvalTaskType → RetrievalStrategy.
 * Drives the per-fixture default when a fixture JSON doesn't carry an
 * explicit `retrieval_strategy` field. Spec §4.2.
 *
 * The table is heuristic — tune empirically once the Phase 7.3 ablation
 * sweep runs. Until then, "rrf-both" is the least-bad fallback for any
 * mode not in the table (spec §9 circular-dependency mitigation).
 */

import type { FailureMode, LongMemEvalTaskType } from "./fixture-types.js";
import type { RetrievalStrategy } from "./retrieval-strategies.js";

const BY_FAILURE_MODE: Record<FailureMode, RetrievalStrategy> = {
  compound:           "turns",
  code_identifier:    "turns",
  coreference:        "rrf-both",
  hedge:              "entries",
  long_context:       "tirqdp",
  negation:           "entries",
  temporal:           "legacy",
  tool_output_buried: "turns",
};

const BY_TASK_TYPE: Record<LongMemEvalTaskType, RetrievalStrategy> = {
  ie:            "rrf-both",
  ku:            "tirqdp",
  temporal:      "legacy",
  multi_session: "tirqdp",
};

const DEFAULT_FALLBACK: RetrievalStrategy = "rrf-both";

export function failureModeToStrategy(
  failureMode: FailureMode | null,
  taskType: LongMemEvalTaskType | null,
): RetrievalStrategy {
  if (failureMode) return BY_FAILURE_MODE[failureMode];
  if (taskType)    return BY_TASK_TYPE[taskType];
  return DEFAULT_FALLBACK;
}
