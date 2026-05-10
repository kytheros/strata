import { describe, it, expect } from "vitest";
import { openDatabase } from "../../../src/storage/database.js";
import {
  saveTrainingPair,
  getTrainingDataCount,
  getTrainingDataStats,
  iterateTrainingData,
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

describe("getTrainingDataStats", () => {
  it("should return zero stats for empty database", () => {
    const db = openDatabase(":memory:");
    const stats = getTrainingDataStats(db);

    expect(stats.extraction.total).toBe(0);
    expect(stats.extraction.highQuality).toBe(0);
    expect(stats.extraction.mediumQuality).toBe(0);
    expect(stats.extraction.heuristicDiverged).toBe(0);
    expect(stats.summarization.total).toBe(0);
    expect(stats.summarization.highQuality).toBe(0);
    expect(stats.summarization.mediumQuality).toBe(0);
    expect(stats.summarization.heuristicDiverged).toBe(0);
    expect(stats.lastCapturedAt).toBeNull();

    db.close();
  });

  it("should break down quality tiers correctly", () => {
    const db = openDatabase(":memory:");

    // High quality extraction (>=0.9)
    saveTrainingPair(db, {
      taskType: "extraction",
      inputText: "high-1",
      outputJson: "{}",
      modelUsed: "gemini",
      qualityScore: 1.0,
      heuristicDiverged: false,
    });
    saveTrainingPair(db, {
      taskType: "extraction",
      inputText: "high-2",
      outputJson: "{}",
      modelUsed: "gemini",
      qualityScore: 0.95,
      heuristicDiverged: false,
    });

    // Medium quality extraction (>=0.7 and <0.9)
    saveTrainingPair(db, {
      taskType: "extraction",
      inputText: "medium-1",
      outputJson: "{}",
      modelUsed: "gemini",
      qualityScore: 0.8,
      heuristicDiverged: false,
    });

    // Low quality extraction (<0.7) — counted in total but not high or medium
    saveTrainingPair(db, {
      taskType: "extraction",
      inputText: "low-1",
      outputJson: "{}",
      modelUsed: "gemini",
      qualityScore: 0.5,
      heuristicDiverged: false,
    });

    // Heuristic-diverged extraction
    saveTrainingPair(db, {
      taskType: "extraction",
      inputText: "diverged-1",
      outputJson: "{}",
      modelUsed: "gemini",
      qualityScore: 1.0,
      heuristicDiverged: true,
    });

    // Summarization entries
    saveTrainingPair(db, {
      taskType: "summarization",
      inputText: "sum-1",
      outputJson: "{}",
      modelUsed: "gemini",
      qualityScore: 0.9,
      heuristicDiverged: false,
    });
    saveTrainingPair(db, {
      taskType: "summarization",
      inputText: "sum-2",
      outputJson: "{}",
      modelUsed: "gemini",
      qualityScore: 0.75,
      heuristicDiverged: true,
    });

    const stats = getTrainingDataStats(db);

    // Extraction: 5 total, 3 high (1.0, 0.95, 1.0-diverged), 1 medium (0.8), 1 diverged
    expect(stats.extraction.total).toBe(5);
    expect(stats.extraction.highQuality).toBe(3); // 1.0, 0.95, 1.0 (diverged)
    expect(stats.extraction.mediumQuality).toBe(1); // 0.8
    expect(stats.extraction.heuristicDiverged).toBe(1);

    // Summarization: 2 total, 1 high (0.9), 1 medium (0.75), 1 diverged
    expect(stats.summarization.total).toBe(2);
    expect(stats.summarization.highQuality).toBe(1); // 0.9
    expect(stats.summarization.mediumQuality).toBe(1); // 0.75
    expect(stats.summarization.heuristicDiverged).toBe(1);

    expect(stats.lastCapturedAt).toBeGreaterThan(0);

    db.close();
  });

  it("should return the most recent timestamp", () => {
    const db = openDatabase(":memory:");

    saveTrainingPair(db, {
      taskType: "extraction",
      inputText: "first",
      outputJson: "{}",
      modelUsed: "gemini",
      qualityScore: 1.0,
      heuristicDiverged: false,
    });

    // Small delay to ensure different timestamps
    const beforeSecond = Date.now();

    saveTrainingPair(db, {
      taskType: "summarization",
      inputText: "second",
      outputJson: "{}",
      modelUsed: "gemini",
      qualityScore: 1.0,
      heuristicDiverged: false,
    });

    const stats = getTrainingDataStats(db);
    expect(stats.lastCapturedAt).toBeGreaterThanOrEqual(beforeSecond);

    db.close();
  });

  it("should handle quality_score boundary at 0.9 correctly", () => {
    const db = openDatabase(":memory:");

    // Exactly 0.9 should be high quality
    saveTrainingPair(db, {
      taskType: "extraction",
      inputText: "boundary",
      outputJson: "{}",
      modelUsed: "gemini",
      qualityScore: 0.9,
      heuristicDiverged: false,
    });

    const stats = getTrainingDataStats(db);
    expect(stats.extraction.highQuality).toBe(1);
    expect(stats.extraction.mediumQuality).toBe(0);

    db.close();
  });
});

describe("iterateTrainingData", () => {
  it("should return empty iterator for empty database", () => {
    const db = openDatabase(":memory:");
    const rows = [...iterateTrainingData(db, "extraction")];
    expect(rows).toHaveLength(0);
    db.close();
  });

  it("should iterate extraction rows only", () => {
    const db = openDatabase(":memory:");

    saveTrainingPair(db, {
      taskType: "extraction",
      inputText: "extract-input",
      outputJson: '{"entries": []}',
      modelUsed: "gemini",
      qualityScore: 1.0,
      heuristicDiverged: false,
    });

    saveTrainingPair(db, {
      taskType: "summarization",
      inputText: "summary-input",
      outputJson: '{"topic": "test"}',
      modelUsed: "gemini",
      qualityScore: 1.0,
      heuristicDiverged: false,
    });

    const rows = [...iterateTrainingData(db, "extraction")];
    expect(rows).toHaveLength(1);
    expect(rows[0].taskType).toBe("extraction");
    expect(rows[0].inputText).toBe("extract-input");
    expect(rows[0].outputJson).toBe('{"entries": []}');
    expect(rows[0].heuristicDiverged).toBe(false);

    db.close();
  });

  it("should filter by minimum quality", () => {
    const db = openDatabase(":memory:");

    saveTrainingPair(db, {
      taskType: "extraction",
      inputText: "high",
      outputJson: "{}",
      modelUsed: "gemini",
      qualityScore: 1.0,
      heuristicDiverged: false,
    });

    saveTrainingPair(db, {
      taskType: "extraction",
      inputText: "medium",
      outputJson: "{}",
      modelUsed: "gemini",
      qualityScore: 0.8,
      heuristicDiverged: false,
    });

    saveTrainingPair(db, {
      taskType: "extraction",
      inputText: "low",
      outputJson: "{}",
      modelUsed: "gemini",
      qualityScore: 0.5,
      heuristicDiverged: false,
    });

    // Default min quality 0.7
    const defaultRows = [...iterateTrainingData(db, "extraction")];
    expect(defaultRows).toHaveLength(2);

    // High quality only
    const highRows = [...iterateTrainingData(db, "extraction", 0.9)];
    expect(highRows).toHaveLength(1);
    expect(highRows[0].inputText).toBe("high");

    // All rows
    const allRows = [...iterateTrainingData(db, "extraction", 0.0)];
    expect(allRows).toHaveLength(3);

    db.close();
  });

  it("should order by created_at ascending", () => {
    const db = openDatabase(":memory:");

    for (let i = 0; i < 3; i++) {
      saveTrainingPair(db, {
        taskType: "extraction",
        inputText: `row-${i}`,
        outputJson: "{}",
        modelUsed: "gemini",
        qualityScore: 1.0,
        heuristicDiverged: false,
      });
    }

    const rows = [...iterateTrainingData(db, "extraction")];
    expect(rows).toHaveLength(3);
    // Should be ordered by created_at ascending
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].createdAt).toBeGreaterThanOrEqual(rows[i - 1].createdAt);
    }

    db.close();
  });

  it("should correctly map heuristicDiverged boolean", () => {
    const db = openDatabase(":memory:");

    saveTrainingPair(db, {
      taskType: "extraction",
      inputText: "diverged",
      outputJson: "{}",
      modelUsed: "gemini",
      qualityScore: 1.0,
      heuristicDiverged: true,
    });

    saveTrainingPair(db, {
      taskType: "extraction",
      inputText: "not-diverged",
      outputJson: "{}",
      modelUsed: "gemini",
      qualityScore: 1.0,
      heuristicDiverged: false,
    });

    const rows = [...iterateTrainingData(db, "extraction")];
    const diverged = rows.find((r) => r.inputText === "diverged");
    const notDiverged = rows.find((r) => r.inputText === "not-diverged");

    expect(diverged?.heuristicDiverged).toBe(true);
    expect(notDiverged?.heuristicDiverged).toBe(false);

    db.close();
  });
});

describe("saveTrainingPair — reasoning_trace column (Phase 0 distillation)", () => {
  it("stores reasoning_trace when provided", () => {
    const db = openDatabase(":memory:");

    saveTrainingPair(db, {
      taskType: "extraction",
      inputText: "test prompt",
      outputJson: '{"entries": []}',
      modelUsed: "gemma4:e4b",
      qualityScore: 1.0,
      heuristicDiverged: false,
      reasoningTrace: "<think>step 1: identify topics</think>",
    });

    const row = db.prepare("SELECT reasoning_trace FROM training_data").get() as {
      reasoning_trace: string | null;
    };
    expect(row.reasoning_trace).toBe("<think>step 1: identify topics</think>");

    db.close();
  });

  it("stores NULL reasoning_trace when not provided", () => {
    const db = openDatabase(":memory:");

    saveTrainingPair(db, {
      taskType: "extraction",
      inputText: "test prompt",
      outputJson: '{"entries": []}',
      modelUsed: "gemma4:e4b",
      qualityScore: 1.0,
      heuristicDiverged: false,
    });

    const row = db.prepare("SELECT reasoning_trace FROM training_data").get() as {
      reasoning_trace: string | null;
    };
    expect(row.reasoning_trace).toBeNull();

    db.close();
  });

  it("iterateTrainingData exposes reasoningTrace field", () => {
    const db = openDatabase(":memory:");

    saveTrainingPair(db, {
      taskType: "extraction",
      inputText: "with trace",
      outputJson: "{}",
      modelUsed: "gemma4:e4b",
      qualityScore: 1.0,
      heuristicDiverged: false,
      reasoningTrace: "<think>reasoning here</think>",
    });

    saveTrainingPair(db, {
      taskType: "extraction",
      inputText: "without trace",
      outputJson: "{}",
      modelUsed: "gemini",
      qualityScore: 1.0,
      heuristicDiverged: false,
    });

    const rows = [...iterateTrainingData(db, "extraction", 0.0)];
    const withTrace = rows.find((r) => r.inputText === "with trace");
    const withoutTrace = rows.find((r) => r.inputText === "without trace");

    expect(withTrace?.reasoningTrace).toBe("<think>reasoning here</think>");
    expect(withoutTrace?.reasoningTrace).toBeNull();

    db.close();
  });

  it("existing rows without reasoning_trace column upgrade cleanly to NULL", () => {
    // Simulate a DB that has the old schema (without reasoning_trace) by opening
    // a fresh DB — the migration adds the column with DEFAULT NULL so all
    // existing rows get NULL automatically.
    const db = openDatabase(":memory:");

    // Insert without reasoning_trace (as if coming from old code)
    db.prepare(
      `INSERT INTO training_data (task_type, input_text, output_json, model_used, quality_score, heuristic_diverged, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("extraction", "old row", "{}", "gemini", 1.0, 0, Date.now());

    const row = db.prepare("SELECT reasoning_trace FROM training_data").get() as {
      reasoning_trace: string | null;
    };
    expect(row.reasoning_trace).toBeNull();

    db.close();
  });
});
