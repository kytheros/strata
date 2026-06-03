/**
 * Unit tests for benchmarks/longmemeval/checkpoint.ts
 *
 * TDD: these tests were written before checkpoint.ts existed.
 * Ticket: resumability — per-question checkpointing for LongMemEval runs.
 */
import { describe, it, expect } from "vitest";
import { rmSync, appendFileSync } from "fs";

// We import the module under test. On first run (before checkpoint.ts exists)
// this import will fail, proving RED.
import { checkpointPath, appendResult, loadCompleted } from "../../benchmarks/longmemeval/checkpoint.js";

// ---- checkpointPath ---------------------------------------------------------

describe("checkpointPath", () => {
  it("returns a path inside benchmarks/longmemeval/data/checkpoints/", () => {
    const p = checkpointPath("run-001");
    expect(p).toMatch(/checkpoints[/\\]run-001\.jsonl$/);
  });

  it("returns different paths for different runIds", () => {
    expect(checkpointPath("a")).not.toBe(checkpointPath("b"));
  });
});

// ---- appendResult + loadCompleted roundtrip ---------------------------------

describe("appendResult / loadCompleted", () => {
  it("roundtrip: single record can be reloaded by questionId", () => {
    const runId = `test-${Date.now()}-roundtrip`; // nosemgrep: mcp-weak-session-id -- test run-id for file artifact uniqueness, not a security token
    const record = { questionId: "q1", verdict: "CORRECT", score: 1.0 };
    appendResult(runId, record);

    const loaded = loadCompleted(runId);
    expect(loaded.size).toBe(1);
    expect(loaded.get("q1")).toMatchObject({ questionId: "q1", verdict: "CORRECT" });

    try { rmSync(checkpointPath(runId)); } catch { /* ignore */ }
  });

  it("multiple appends accumulate across three records", () => {
    const runId = `test-${Date.now()}-multi`; // nosemgrep: mcp-weak-session-id -- test run-id for file artifact uniqueness, not a security token
    appendResult(runId, { questionId: "q1", verdict: "CORRECT" });
    appendResult(runId, { questionId: "q2", verdict: "INCORRECT" });
    appendResult(runId, { questionId: "q3", verdict: "CORRECT" });

    const loaded = loadCompleted(runId);
    expect(loaded.size).toBe(3);
    expect(loaded.has("q1")).toBe(true);
    expect(loaded.has("q2")).toBe(true);
    expect(loaded.has("q3")).toBe(true);
    expect(loaded.get("q2")).toMatchObject({ verdict: "INCORRECT" });

    try { rmSync(checkpointPath(runId)); } catch { /* ignore */ }
  });

  it("loadCompleted on missing file returns empty Map", () => {
    const loaded = loadCompleted("run-that-does-not-exist-xyz-12345-never");
    expect(loaded).toBeInstanceOf(Map);
    expect(loaded.size).toBe(0);
  });

  it("tolerates a corrupt (partial) trailing line without throwing", () => {
    const runId = `test-${Date.now()}-corrupt`; // nosemgrep: mcp-weak-session-id -- test run-id for file artifact uniqueness, not a security token
    // Write a valid record first
    appendResult(runId, { questionId: "q1", verdict: "CORRECT" });

    // Append a corrupt partial line (simulates a crash mid-write)
    appendFileSync(checkpointPath(runId), '{"questionId":"q2","verdict":"INCOR\n');

    // loadCompleted must not throw; must return valid q1 and silently skip corrupt q2
    let loaded: Map<string, unknown>;
    expect(() => { loaded = loadCompleted(runId); }).not.toThrow();
    expect(loaded!.size).toBe(1);
    expect(loaded!.has("q1")).toBe(true);
    expect(loaded!.has("q2")).toBe(false);

    try { rmSync(checkpointPath(runId)); } catch { /* ignore */ }
  });
});
