import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { saveTrainingPair } from "../../src/extensions/llm-extraction/training-capture.js";

describe("training_data — reasoning_tool_call + reasoning_final_answer", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("accepts reasoning_tool_call as a valid task_type", () => {
    expect(() => {
      saveTrainingPair(db, {
        taskType: "reasoning_tool_call",
        inputText: '[{"role":"user","content":"test"}]',
        outputJson: '{"tool_name":"search","tool_args":{"q":"foo"}}',
        modelUsed: "gpt-4o-2024-08-06",
        qualityScore: 1.0,
        heuristicDiverged: false,
        reasoningTrace: "I should search for foo.",
      });
    }).not.toThrow();

    const row = db.prepare(
      "SELECT task_type, reasoning_trace FROM training_data WHERE task_type = ?"
    ).get("reasoning_tool_call") as { task_type: string; reasoning_trace: string };
    expect(row.task_type).toBe("reasoning_tool_call");
    expect(row.reasoning_trace).toBe("I should search for foo.");
  });

  it("accepts reasoning_final_answer as a valid task_type", () => {
    expect(() => {
      saveTrainingPair(db, {
        taskType: "reasoning_final_answer",
        inputText: '[{"role":"user","content":"test"}]',
        outputJson: '"final answer"',
        modelUsed: "gpt-4o-2024-08-06",
        qualityScore: 0.0,
        heuristicDiverged: false,
      });
    }).not.toThrow();
  });

  it("still accepts the existing four task_types", () => {
    for (const taskType of ["extraction", "summarization", "dialogue", "conflict"] as const) {
      expect(() => {
        saveTrainingPair(db, {
          taskType,
          inputText: "x",
          outputJson: "x",
          modelUsed: "m",
          qualityScore: 1.0,
          heuristicDiverged: false,
        });
      }).not.toThrow();
    }
  });

  it("rejects an unknown task_type", () => {
    const stmt = db.prepare(`
      INSERT INTO training_data (task_type, input_text, output_json, model_used, quality_score, heuristic_diverged, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    expect(() => stmt.run("not_a_real_task_type", "x", "x", "m", 1.0, 0, Date.now()))
      .toThrow(/CHECK constraint failed/);
  });

});
