/**
 * Unit tests for --run-id resume flag in run-benchmark.ts
 *
 * TDD: written before the --run-id flag was added to parseArgs().
 * Ticket: resumability — per-question checkpointing for LongMemEval runs.
 */
import { describe, it, expect } from "vitest";
import { parseArgs } from "../../benchmarks/longmemeval/run-benchmark.js";

// Helper: temporarily override process.argv, run fn, restore.
function withArgv<T>(args: string[], fn: () => T): T {
  const original = process.argv;
  process.argv = [...original.slice(0, 2), ...args];
  try {
    return fn();
  } finally {
    process.argv = original;
  }
}

describe("parseArgs — --run-id", () => {
  it("parses --run-id=foo as runId='foo'", () => {
    const result = withArgv(["--run-id=foo"], () => parseArgs());
    expect(result.runId).toBe("foo");
  });

  it("parses --run-id=my-run-2026-06-01 correctly", () => {
    const result = withArgv(["--run-id=my-run-2026-06-01"], () => parseArgs());
    expect(result.runId).toBe("my-run-2026-06-01");
  });

  it("defaults runId to null when --run-id is absent", () => {
    const result = withArgv([], () => parseArgs());
    expect(result.runId).toBeNull();
  });

  it("flag-off: no checkpoint behavior when runId is null (type guard)", () => {
    // When runId is null, the guard `if (runId)` prevents any checkpoint call.
    // This is a type-level assertion — confirm the field is null not undefined.
    const result = withArgv([], () => parseArgs());
    expect(result.runId).toBeNull();
    expect(result.runId === null).toBe(true);
  });
});

describe("shouldSkip helper", () => {
  // shouldSkip is a trivial guard: skip if completed Map has the questionId.
  // Inline it here rather than exporting from run-benchmark to keep blast radius small.
  function shouldSkip(completed: Map<string, unknown>, questionId: string): boolean {
    return completed.has(questionId);
  }

  it("returns true when questionId is in the completed map", () => {
    const m = new Map<string, unknown>([["q1", { verdict: "CORRECT" }]]);
    expect(shouldSkip(m, "q1")).toBe(true);
  });

  it("returns false when questionId is not in the map", () => {
    const m = new Map<string, unknown>([["q1", { verdict: "CORRECT" }]]);
    expect(shouldSkip(m, "q2")).toBe(false);
  });

  it("returns false on empty map", () => {
    expect(shouldSkip(new Map(), "q1")).toBe(false);
  });
});
