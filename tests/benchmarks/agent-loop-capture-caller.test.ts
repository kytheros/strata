import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { getTrainingDataCount } from "../../src/extensions/llm-extraction/training-capture.js";
import type { CapturePair } from "../../benchmarks/longmemeval/agent-loop.js";
import { persistCaptureBuffer } from "../../benchmarks/longmemeval/run-benchmark.js";

describe("persistCaptureBuffer — atomic write with judge-backfilled quality", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("writes all pairs with quality_score=1.0 when verdict=CORRECT", () => {
    const buffer: CapturePair[] = [
      {
        kind: "reasoning_tool_call",
        messages: [{ role: "user", content: "Q" }],
        toolCall: { name: "search_sessions", args: { query: "foo" } },
        reasoning: "I'll search.",
      },
      {
        kind: "reasoning_final_answer",
        messages: [{ role: "user", content: "Q" }],
        answer: "the answer",
        reasoning: null,
      },
    ];
    persistCaptureBuffer(db, buffer, "CORRECT", "gpt-4o-2024-08-06");

    const counts = getTrainingDataCount(db);
    expect(counts.reasoning_tool_call).toBe(1);
    expect(counts.reasoning_final_answer).toBe(1);

    const rows = db.prepare(
      "SELECT quality_score, reasoning_trace, task_type FROM training_data ORDER BY id"
    ).all() as Array<{ quality_score: number; reasoning_trace: string | null; task_type: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].task_type).toBe("reasoning_tool_call");
    expect(rows[0].quality_score).toBe(1.0);
    expect(rows[0].reasoning_trace).toBe("I'll search.");
    expect(rows[1].task_type).toBe("reasoning_final_answer");
    expect(rows[1].quality_score).toBe(1.0);
    expect(rows[1].reasoning_trace).toBeNull();
  });

  it("writes all pairs with quality_score=0.0 when verdict=INCORRECT", () => {
    const buffer: CapturePair[] = [{
      kind: "reasoning_final_answer",
      messages: [{ role: "user", content: "Q" }],
      answer: "wrong answer",
      reasoning: null,
    }];
    persistCaptureBuffer(db, buffer, "INCORRECT", "gpt-4o-2024-08-06");

    const row = db.prepare(
      "SELECT quality_score FROM training_data"
    ).get() as { quality_score: number };
    expect(row.quality_score).toBe(0.0);
  });

  it("writes nothing when verdict is null", () => {
    const buffer: CapturePair[] = [{
      kind: "reasoning_final_answer",
      messages: [],
      answer: "x",
      reasoning: null,
    }];
    persistCaptureBuffer(db, buffer, null, "gpt-4o-2024-08-06");

    const counts = getTrainingDataCount(db);
    expect(counts.reasoning_tool_call).toBe(0);
    expect(counts.reasoning_final_answer).toBe(0);
  });

  it("writes nothing when buffer is empty", () => {
    persistCaptureBuffer(db, [], "CORRECT", "gpt-4o-2024-08-06");
    const counts = getTrainingDataCount(db);
    expect(counts.reasoning_final_answer).toBe(0);
  });

  it("logs warn and continues when a single saveTrainingPair throws", () => {
    const buffer: CapturePair[] = [
      { kind: "reasoning_final_answer", messages: [], answer: "a", reasoning: null },
      { kind: "reasoning_final_answer", messages: [], answer: "b", reasoning: null },
    ];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Close the DB to force writes to throw — persistCaptureBuffer must not bubble.
    db.close();
    expect(() => persistCaptureBuffer(db, buffer, "CORRECT", "gpt-4o-2024-08-06"))
      .not.toThrow();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
    // Re-open for afterEach cleanup
    db = openDatabase(":memory:");
  });

  it("serializes messages and tool_call as JSON in input_text/output_json", () => {
    const buffer: CapturePair[] = [{
      kind: "reasoning_tool_call",
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "Q" }],
      toolCall: { name: "search_sessions", args: { query: "foo", limit: 10 } },
      reasoning: "search now",
    }];
    persistCaptureBuffer(db, buffer, "CORRECT", "gpt-4o-2024-08-06");

    const row = db.prepare(
      "SELECT input_text, output_json FROM training_data WHERE task_type = 'reasoning_tool_call'"
    ).get() as { input_text: string; output_json: string };

    const parsedInput = JSON.parse(row.input_text);
    expect(parsedInput).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "Q" },
    ]);

    const parsedOutput = JSON.parse(row.output_json);
    expect(parsedOutput).toEqual({
      name: "search_sessions",
      args: { query: "foo", limit: 10 },
    });
  });
});
