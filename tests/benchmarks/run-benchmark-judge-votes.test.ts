import { describe, it, expect } from "vitest";
import { parseArgs } from "../../benchmarks/longmemeval/run-benchmark.js";

describe("run-benchmark argparser — --judge-votes", () => {
  it("parses --judge-votes=3 as 3", () => {
    const originalArgv = process.argv;
    process.argv = [...originalArgv.slice(0, 2), "--judge-votes=3"];
    expect(parseArgs().judgeVotes).toBe(3);
    process.argv = originalArgv;
  });

  it("defaults judgeVotes to 1", () => {
    const originalArgv = process.argv;
    const originalEnv = process.env.LONGMEMEVAL_JUDGE_VOTES;
    process.argv = [...originalArgv.slice(0, 2)];
    delete process.env.LONGMEMEVAL_JUDGE_VOTES;
    expect(parseArgs().judgeVotes).toBe(1);
    process.argv = originalArgv;
    if (originalEnv !== undefined) process.env.LONGMEMEVAL_JUDGE_VOTES = originalEnv;
  });

  it("reads LONGMEMEVAL_JUDGE_VOTES env when CLI flag absent", () => {
    const originalArgv = process.argv;
    const originalEnv = process.env.LONGMEMEVAL_JUDGE_VOTES;
    process.argv = [...originalArgv.slice(0, 2)];
    process.env.LONGMEMEVAL_JUDGE_VOTES = "5";
    expect(parseArgs().judgeVotes).toBe(5);
    process.argv = originalArgv;
    if (originalEnv === undefined) delete process.env.LONGMEMEVAL_JUDGE_VOTES;
    else process.env.LONGMEMEVAL_JUDGE_VOTES = originalEnv;
  });

  it("CLI flag takes precedence over env", () => {
    const originalArgv = process.argv;
    const originalEnv = process.env.LONGMEMEVAL_JUDGE_VOTES;
    process.argv = [...originalArgv.slice(0, 2), "--judge-votes=2"];
    process.env.LONGMEMEVAL_JUDGE_VOTES = "5";
    expect(parseArgs().judgeVotes).toBe(2);
    process.argv = originalArgv;
    if (originalEnv === undefined) delete process.env.LONGMEMEVAL_JUDGE_VOTES;
    else process.env.LONGMEMEVAL_JUDGE_VOTES = originalEnv;
  });
});
