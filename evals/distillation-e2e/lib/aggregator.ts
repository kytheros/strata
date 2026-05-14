import type { FailureMode, LongMemEvalTaskType } from "./fixture-types.js";

export interface FixtureResult {
  id: string;
  failure_mode: FailureMode | null;
  longmemeval_task_type: LongMemEvalTaskType | null;
  answerScore: number;
  recallScore: number;
}

export interface AggregateOutput {
  overall: { answerAccuracy: number; recallAt10: number };
  perFailureMode: Partial<Record<FailureMode, number>>;
  perTaskType: Partial<Record<LongMemEvalTaskType, number>>;
}

function avg(rows: number[]): number {
  return rows.length === 0 ? 0 : rows.reduce((s, r) => s + r, 0) / rows.length;
}

export function aggregate(results: FixtureResult[]): AggregateOutput {
  const overall = {
    answerAccuracy: avg(results.map((r) => r.answerScore)),
    recallAt10: avg(results.map((r) => r.recallScore)),
  };

  const fmGroups: Map<FailureMode, number[]> = new Map();
  const ttGroups: Map<LongMemEvalTaskType, number[]> = new Map();

  for (const r of results) {
    if (r.failure_mode) {
      const arr = fmGroups.get(r.failure_mode) ?? [];
      arr.push(r.answerScore);
      fmGroups.set(r.failure_mode, arr);
    }
    if (r.longmemeval_task_type) {
      const arr = ttGroups.get(r.longmemeval_task_type) ?? [];
      arr.push(r.answerScore);
      ttGroups.set(r.longmemeval_task_type, arr);
    }
  }

  const perFailureMode: Partial<Record<FailureMode, number>> = {};
  const perTaskType: Partial<Record<LongMemEvalTaskType, number>> = {};
  for (const [k, v] of fmGroups) perFailureMode[k] = avg(v);
  for (const [k, v] of ttGroups) perTaskType[k] = avg(v);

  return { overall, perFailureMode, perTaskType };
}
