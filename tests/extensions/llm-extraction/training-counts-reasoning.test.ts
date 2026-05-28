import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../../../src/storage/database.js";
import {
  saveTrainingPair,
  getTrainingDataCount,
  getTrainingDataStats,
} from "../../../src/extensions/llm-extraction/training-capture.js";

describe("training-data counts/stats — reasoning task_types", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("counts reasoning_tool_call and reasoning_final_answer rows", () => {
    for (let i = 0; i < 3; i++) {
      saveTrainingPair(db, {
        taskType: "reasoning_tool_call",
        inputText: "x", outputJson: "x", modelUsed: "m",
        qualityScore: 1.0, heuristicDiverged: false,
      });
    }
    for (let i = 0; i < 5; i++) {
      saveTrainingPair(db, {
        taskType: "reasoning_final_answer",
        inputText: "x", outputJson: "x", modelUsed: "m",
        qualityScore: 1.0, heuristicDiverged: false,
      });
    }

    const counts = getTrainingDataCount(db);
    expect(counts.reasoning_tool_call).toBe(3);
    expect(counts.reasoning_final_answer).toBe(5);
    // Existing fields preserved at zero
    expect(counts.extraction).toBe(0);
    expect(counts.summarization).toBe(0);
    expect(counts.dialogue).toBe(0);
    expect(counts.conflict).toBe(0);
  });

  it("only counts pairs with quality_score >= 0.7", () => {
    // Above threshold
    saveTrainingPair(db, {
      taskType: "reasoning_tool_call",
      inputText: "x", outputJson: "x", modelUsed: "m",
      qualityScore: 1.0, heuristicDiverged: false,
    });
    // Below threshold — should not be counted
    saveTrainingPair(db, {
      taskType: "reasoning_tool_call",
      inputText: "x", outputJson: "x", modelUsed: "m",
      qualityScore: 0.0, heuristicDiverged: false,
    });

    const counts = getTrainingDataCount(db);
    expect(counts.reasoning_tool_call).toBe(1);
  });

  it("reports per-reasoning-task-type stats with the same shape as existing task_types", () => {
    // One high-quality (>= 0.9), one medium-quality (0.7-0.9), one below
    saveTrainingPair(db, {
      taskType: "reasoning_tool_call",
      inputText: "x", outputJson: "x", modelUsed: "m",
      qualityScore: 1.0, heuristicDiverged: false,
    });
    saveTrainingPair(db, {
      taskType: "reasoning_tool_call",
      inputText: "x", outputJson: "x", modelUsed: "m",
      qualityScore: 0.8, heuristicDiverged: true,
    });
    saveTrainingPair(db, {
      taskType: "reasoning_tool_call",
      inputText: "x", outputJson: "x", modelUsed: "m",
      qualityScore: 0.0, heuristicDiverged: false,
    });

    const stats = getTrainingDataStats(db);
    expect(stats.reasoning_tool_call.total).toBe(3);
    expect(stats.reasoning_tool_call.highQuality).toBe(1);
    expect(stats.reasoning_tool_call.mediumQuality).toBe(1);
    expect(stats.reasoning_tool_call.heuristicDiverged).toBe(1);

    // reasoning_final_answer should be present even when zero
    expect(stats.reasoning_final_answer.total).toBe(0);
    expect(stats.reasoning_final_answer.highQuality).toBe(0);
  });

  it("preserves existing extraction/summarization/dialogue/conflict stats fields", () => {
    const stats = getTrainingDataStats(db);
    expect(stats.extraction.total).toBe(0);
    expect(stats.summarization.total).toBe(0);
    expect(stats.dialogue.total).toBe(0);
    expect(stats.conflict.total).toBe(0);
    expect(stats.lastCapturedAt).toBeNull();
  });
});
