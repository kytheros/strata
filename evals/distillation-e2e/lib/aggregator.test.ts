import { describe, expect, test } from "vitest";
import { aggregate } from "./aggregator.js";
import type { FixtureResult } from "./aggregator.js";

describe("aggregator", () => {
  const results: FixtureResult[] = [
    { id: "f1", failure_mode: "compound", longmemeval_task_type: null, answerScore: 1, recallScore: 1 },
    { id: "f2", failure_mode: "compound", longmemeval_task_type: null, answerScore: 0, recallScore: 1 },
    { id: "f3", failure_mode: "hedge", longmemeval_task_type: null, answerScore: 1, recallScore: 0 },
    { id: "f4", failure_mode: null, longmemeval_task_type: "ie", answerScore: 1, recallScore: 1 },
  ];

  test("computes overall answer accuracy", () => {
    expect(aggregate(results).overall.answerAccuracy).toBeCloseTo(0.75, 5);
  });

  test("computes overall Recall@10", () => {
    expect(aggregate(results).overall.recallAt10).toBeCloseTo(0.75, 5);
  });

  test("computes per-failure-mode breakdown", () => {
    const agg = aggregate(results);
    expect(agg.perFailureMode.compound!).toBeCloseTo(0.5, 5);
    expect(agg.perFailureMode.hedge!).toBeCloseTo(1.0, 5);
  });

  test("computes per-task-type breakdown", () => {
    const agg = aggregate(results);
    expect(agg.perTaskType.ie!).toBeCloseTo(1.0, 5);
  });
});
