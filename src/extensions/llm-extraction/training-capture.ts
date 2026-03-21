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
  taskType: "extraction" | "summarization";
  inputText: string;
  outputJson: string;
  modelUsed: string;
  qualityScore: number;
  heuristicDiverged: boolean;
}

/** Counts of training data per task type */
export interface TrainingDataCounts {
  extraction: number;
  summarization: number;
}

/**
 * Save a training pair to the database.
 * Inserts into the training_data table for later use in fine-tuning.
 */
export function saveTrainingPair(db: Database.Database, pair: TrainingPair): void {
  const stmt = db.prepare(`
    INSERT INTO training_data
      (task_type, input_text, output_json, model_used, quality_score, heuristic_diverged, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    pair.taskType,
    pair.inputText,
    pair.outputJson,
    pair.modelUsed,
    pair.qualityScore,
    pair.heuristicDiverged ? 1 : 0,
    Date.now()
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
  };
}
