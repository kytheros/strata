import { describe, it, expect } from "vitest";
import { openDatabase } from "../../../src/storage/database.js";
import {
  saveTrainingPair,
  getTrainingDataCount,
} from "../../../src/extensions/llm-extraction/training-capture.js";

describe("saveTrainingPair", () => {
  it("should insert a training pair into the database", () => {
    const db = openDatabase(":memory:");

    saveTrainingPair(db, {
      taskType: "extraction",
      inputText: "test prompt",
      outputJson: '{"entries": []}',
      modelUsed: "gemini-2.5-flash",
      qualityScore: 1.0,
      heuristicDiverged: false,
    });

    const row = db.prepare("SELECT * FROM training_data").get() as {
      id: number;
      task_type: string;
      input_text: string;
      output_json: string;
      model_used: string;
      quality_score: number;
      heuristic_diverged: number;
      created_at: number;
      used_in_run: number | null;
    };

    expect(row).toBeDefined();
    expect(row.task_type).toBe("extraction");
    expect(row.input_text).toBe("test prompt");
    expect(row.output_json).toBe('{"entries": []}');
    expect(row.model_used).toBe("gemini-2.5-flash");
    expect(row.quality_score).toBe(1.0);
    expect(row.heuristic_diverged).toBe(0);
    expect(row.created_at).toBeGreaterThan(0);
    expect(row.used_in_run).toBeNull();

    db.close();
  });

  it("should store heuristic_diverged as 1 when true", () => {
    const db = openDatabase(":memory:");

    saveTrainingPair(db, {
      taskType: "extraction",
      inputText: "prompt",
      outputJson: '{"entries": [{"type": "decision"}]}',
      modelUsed: "gemini-2.5-flash",
      qualityScore: 1.0,
      heuristicDiverged: true,
    });

    const row = db.prepare("SELECT heuristic_diverged FROM training_data").get() as {
      heuristic_diverged: number;
    };
    expect(row.heuristic_diverged).toBe(1);

    db.close();
  });

  it("should accept summarization task type", () => {
    const db = openDatabase(":memory:");

    saveTrainingPair(db, {
      taskType: "summarization",
      inputText: "prompt",
      outputJson: '{"topic": "test"}',
      modelUsed: "gemini-2.5-flash",
      qualityScore: 0.8,
      heuristicDiverged: false,
    });

    const row = db.prepare("SELECT task_type, quality_score FROM training_data").get() as {
      task_type: string;
      quality_score: number;
    };
    expect(row.task_type).toBe("summarization");
    expect(row.quality_score).toBe(0.8);

    db.close();
  });

  it("should auto-increment IDs", () => {
    const db = openDatabase(":memory:");

    for (let i = 0; i < 3; i++) {
      saveTrainingPair(db, {
        taskType: "extraction",
        inputText: `prompt ${i}`,
        outputJson: "{}",
        modelUsed: "gemini-2.5-flash",
        qualityScore: 1.0,
        heuristicDiverged: false,
      });
    }

    const rows = db.prepare("SELECT id FROM training_data ORDER BY id").all() as { id: number }[];
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);

    db.close();
  });
});

describe("getTrainingDataCount", () => {
  it("should return zero counts for empty database", () => {
    const db = openDatabase(":memory:");
    const counts = getTrainingDataCount(db);
    expect(counts.extraction).toBe(0);
    expect(counts.summarization).toBe(0);
    db.close();
  });

  it("should count extraction and summarization pairs separately", () => {
    const db = openDatabase(":memory:");

    for (let i = 0; i < 5; i++) {
      saveTrainingPair(db, {
        taskType: "extraction",
        inputText: `extract-${i}`,
        outputJson: "{}",
        modelUsed: "gemini",
        qualityScore: 1.0,
        heuristicDiverged: false,
      });
    }

    for (let i = 0; i < 3; i++) {
      saveTrainingPair(db, {
        taskType: "summarization",
        inputText: `summary-${i}`,
        outputJson: "{}",
        modelUsed: "gemini",
        qualityScore: 1.0,
        heuristicDiverged: false,
      });
    }

    const counts = getTrainingDataCount(db);
    expect(counts.extraction).toBe(5);
    expect(counts.summarization).toBe(3);

    db.close();
  });

  it("should only count pairs with quality >= 0.7", () => {
    const db = openDatabase(":memory:");

    // High quality
    saveTrainingPair(db, {
      taskType: "extraction",
      inputText: "good",
      outputJson: "{}",
      modelUsed: "gemini",
      qualityScore: 1.0,
      heuristicDiverged: false,
    });

    // Borderline (included)
    saveTrainingPair(db, {
      taskType: "extraction",
      inputText: "ok",
      outputJson: "{}",
      modelUsed: "gemini",
      qualityScore: 0.7,
      heuristicDiverged: false,
    });

    // Low quality (excluded)
    saveTrainingPair(db, {
      taskType: "extraction",
      inputText: "bad",
      outputJson: "{}",
      modelUsed: "gemini",
      qualityScore: 0.5,
      heuristicDiverged: false,
    });

    const counts = getTrainingDataCount(db);
    expect(counts.extraction).toBe(2); // 1.0 + 0.7, not 0.5

    db.close();
  });
});
