/**
 * Training data capture for local model distillation.
 *
 * Passively accumulates (input, output) pairs from successful LLM calls.
 * These pairs are stored in the training_data table and used later
 * by the strata-distill pipeline for QLoRA fine-tuning.
 *
 * CRITICAL: All capture operations are wrapped in try/catch and must
 * NEVER affect the primary extraction/summarization path.
 */

import type Database from "better-sqlite3";

/** A training pair ready for insertion */
export interface TrainingPair {
  taskType: "extraction" | "summarization" | "dialogue" | "conflict";
  inputText: string;
  outputJson: string;
  modelUsed: string;
  qualityScore: number;
  heuristicDiverged: boolean;
  /**
   * Full raw LLM response including <think>...</think> blocks, captured
   * BEFORE extractJson() strips the reasoning trace. NULL when the provider
   * did not emit a reasoning trace (e.g. Gemini frontier model).
   */
  reasoningTrace?: string | null;
}

/** Counts of training data per task type */
export interface TrainingDataCounts {
  extraction: number;
  summarization: number;
  dialogue: number;
  conflict: number;
}

/**
 * Save a training pair to the database.
 * Inserts into the training_data table for later use in fine-tuning.
 */
export function saveTrainingPair(db: Database.Database, pair: TrainingPair): void {
  const stmt = db.prepare(`
    INSERT INTO training_data
      (task_type, input_text, output_json, model_used, quality_score, heuristic_diverged, created_at, reasoning_trace)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    pair.taskType,
    pair.inputText,
    pair.outputJson,
    pair.modelUsed,
    pair.qualityScore,
    pair.heuristicDiverged ? 1 : 0,
    Date.now(),
    pair.reasoningTrace ?? null
  );
}

/**
 * Get counts of training data per task type (only pairs with quality >= 0.7).
 */
export function getTrainingDataCount(db: Database.Database): TrainingDataCounts {
  const rows = db.prepare(`
    SELECT task_type, COUNT(*) as count
    FROM training_data
    WHERE quality_score >= 0.7
    GROUP BY task_type
  `).all() as Array<{ task_type: string; count: number }>;

  return {
    extraction: rows.find((r) => r.task_type === "extraction")?.count ?? 0,
    summarization: rows.find((r) => r.task_type === "summarization")?.count ?? 0,
    dialogue: rows.find((r) => r.task_type === "dialogue")?.count ?? 0,
    conflict: rows.find((r) => r.task_type === "conflict")?.count ?? 0,
  };
}

/** Quality breakdown per task type */
export interface TaskStats {
  total: number;
  highQuality: number;     // quality_score >= 0.9
  mediumQuality: number;   // quality_score >= 0.7 AND < 0.9
  heuristicDiverged: number;
}

/** Detailed training data statistics */
export interface TrainingDataStats {
  extraction: TaskStats;
  summarization: TaskStats;
  dialogue: TaskStats;
  conflict: TaskStats;
  lastCapturedAt: number | null;  // Unix timestamp (ms) of most recent pair
}

/**
 * Get detailed training data statistics including quality breakdown
 * and heuristic divergence counts per task type.
 */
export function getTrainingDataStats(db: Database.Database): TrainingDataStats {
  // Get per-task-type breakdown in a single query
  const rows = db.prepare(`
    SELECT
      task_type,
      COUNT(*) as total,
      SUM(CASE WHEN quality_score >= 0.9 THEN 1 ELSE 0 END) as high_quality,
      SUM(CASE WHEN quality_score >= 0.7 AND quality_score < 0.9 THEN 1 ELSE 0 END) as medium_quality,
      SUM(CASE WHEN heuristic_diverged = 1 THEN 1 ELSE 0 END) as heuristic_diverged
    FROM training_data
    GROUP BY task_type
  `).all() as Array<{
    task_type: string;
    total: number;
    high_quality: number;
    medium_quality: number;
    heuristic_diverged: number;
  }>;

  const extractionRow = rows.find((r) => r.task_type === "extraction");
  const summarizationRow = rows.find((r) => r.task_type === "summarization");
  const dialogueRow = rows.find((r) => r.task_type === "dialogue");
  const conflictRow = rows.find((r) => r.task_type === "conflict");

  // Get most recent pair timestamp
  const lastRow = db.prepare(`
    SELECT MAX(created_at) as last_at FROM training_data
  `).get() as { last_at: number | null } | undefined;

  return {
    extraction: {
      total: extractionRow?.total ?? 0,
      highQuality: extractionRow?.high_quality ?? 0,
      mediumQuality: extractionRow?.medium_quality ?? 0,
      heuristicDiverged: extractionRow?.heuristic_diverged ?? 0,
    },
    summarization: {
      total: summarizationRow?.total ?? 0,
      highQuality: summarizationRow?.high_quality ?? 0,
      mediumQuality: summarizationRow?.medium_quality ?? 0,
      heuristicDiverged: summarizationRow?.heuristic_diverged ?? 0,
    },
    dialogue: {
      total: dialogueRow?.total ?? 0,
      highQuality: dialogueRow?.high_quality ?? 0,
      mediumQuality: dialogueRow?.medium_quality ?? 0,
      heuristicDiverged: dialogueRow?.heuristic_diverged ?? 0,
    },
    conflict: {
      total: conflictRow?.total ?? 0,
      highQuality: conflictRow?.high_quality ?? 0,
      mediumQuality: conflictRow?.medium_quality ?? 0,
      heuristicDiverged: conflictRow?.heuristic_diverged ?? 0,
    },
    lastCapturedAt: lastRow?.last_at ?? null,
  };
}

/** A single training data row for export */
export interface TrainingDataRow {
  id: number;
  taskType: string;
  inputText: string;
  outputJson: string;
  modelUsed: string;
  qualityScore: number;
  heuristicDiverged: boolean;
  createdAt: number;
  /** Full raw LLM response with reasoning trace; NULL when not captured. */
  reasoningTrace: string | null;
}

/**
 * Query training data rows for export, filtered by task type and minimum quality.
 * Returns an iterator to avoid loading all rows into memory at once.
 */
export function* iterateTrainingData(
  db: Database.Database,
  taskType: "extraction" | "summarization" | "dialogue" | "conflict",
  minQuality: number = 0.7
): Generator<TrainingDataRow> {
  const stmt = db.prepare(`
    SELECT id, task_type, input_text, output_json, model_used, quality_score, heuristic_diverged, created_at, reasoning_trace
    FROM training_data
    WHERE task_type = ? AND quality_score >= ?
    ORDER BY created_at ASC
  `);

  for (const row of stmt.iterate(taskType, minQuality) as Iterable<{
    id: number;
    task_type: string;
    input_text: string;
    output_json: string;
    model_used: string;
    quality_score: number;
    heuristic_diverged: number;
    created_at: number;
    reasoning_trace: string | null;
  }>) {
    yield {
      id: row.id,
      taskType: row.task_type,
      inputText: row.input_text,
      outputJson: row.output_json,
      modelUsed: row.model_used,
      qualityScore: row.quality_score,
      heuristicDiverged: row.heuristic_diverged === 1,
      createdAt: row.created_at,
      reasoningTrace: row.reasoning_trace,
    };
  }
}
