import { describe, it, expect } from "vitest";
import { aggregateCanaryRuns } from "../../benchmarks/longmemeval/run-canary.js";

describe("aggregateCanaryRuns", () => {
  it("computes mean + std-dev of task-averaged accuracy", () => {
    const runs = [
      { taskAvg: 0.791, raw: 0.794, perQuestion: [], resultsPath: "run1.json" },
      { taskAvg: 0.794, raw: 0.798, perQuestion: [], resultsPath: "run2.json" },
      { taskAvg: 0.788, raw: 0.790, perQuestion: [], resultsPath: "run3.json" },
    ];
    const summary = aggregateCanaryRuns(runs as never);
    expect(summary.taskAvgMean).toBeCloseTo(0.791, 3);
    expect(summary.taskAvgStdDev).toBeGreaterThan(0);
    expect(summary.taskAvgStdDev).toBeLessThan(0.005);
  });

  it("classifies per-question stability", () => {
    const runs = [
      { taskAvg: 0.5, raw: 0.5, resultsPath: "run1.json", perQuestion: [
        { questionId: "q1", judgeVerdict: "CORRECT" },
        { questionId: "q2", judgeVerdict: "CORRECT" },
      ]},
      { taskAvg: 0.5, raw: 0.5, resultsPath: "run2.json", perQuestion: [
        { questionId: "q1", judgeVerdict: "CORRECT" },
        { questionId: "q2", judgeVerdict: "INCORRECT" },
      ]},
      { taskAvg: 0.5, raw: 0.5, resultsPath: "run3.json", perQuestion: [
        { questionId: "q1", judgeVerdict: "CORRECT" },
        { questionId: "q2", judgeVerdict: "CORRECT" },
      ]},
    ];
    const summary = aggregateCanaryRuns(runs as never);
    expect(summary.stableCount).toBe(1); // q1 stable CORRECT
    expect(summary.unstableCount).toBe(1); // q2 flipped
    expect(summary.perQuestionMajority.get("q1")).toBe("CORRECT");
    expect(summary.perQuestionMajority.get("q2")).toBe("CORRECT"); // 2-of-3 CORRECT
  });
});
