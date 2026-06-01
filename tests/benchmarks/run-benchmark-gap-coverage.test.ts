import { describe, it, expect, afterEach } from "vitest";
import { parseArgs } from "../../benchmarks/longmemeval/run-benchmark.js";

describe("run-benchmark argparser — --gap-coverage", () => {
  const savedArgv = process.argv.slice();

  afterEach(() => {
    process.argv = savedArgv.slice();
  });

  it("gapCoverage defaults to false when flag absent", () => {
    process.argv = [...savedArgv.slice(0, 2)];
    const args = parseArgs();
    expect(args.gapCoverage).toBe(false);
  });

  it("gapCoverage is true when --gap-coverage present", () => {
    process.argv = [...savedArgv.slice(0, 2), "--gap-coverage"];
    const args = parseArgs();
    expect(args.gapCoverage).toBe(true);
  });

  it("gapCoverageRounds defaults to 1", () => {
    process.argv = [...savedArgv.slice(0, 2)];
    const args = parseArgs();
    expect(args.gapCoverageRounds).toBe(1);
  });

  it("gapCoverageRounds is parsed from --gap-coverage-rounds=N", () => {
    process.argv = [...savedArgv.slice(0, 2), "--gap-coverage-rounds=3"];
    const args = parseArgs();
    expect(args.gapCoverageRounds).toBe(3);
  });

  it("existing --gap-judge flag is unchanged by gap-coverage flag", () => {
    process.argv = [...savedArgv.slice(0, 2), "--gap-judge", "--gap-coverage"];
    const args = parseArgs();
    expect(args.gapJudgeEnabled).toBe(true);
    expect(args.gapCoverage).toBe(true);
  });
});
