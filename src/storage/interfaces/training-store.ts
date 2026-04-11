/**
 * ITrainingStore interface: async-first contract for training data persistence.
 *
 * Extracted from training-capture.ts to allow Postgres (and future) adapters
 * without direct db.prepare() calls.
 */

import type { TrainingPair, TrainingDataCounts, TrainingDataStats, TrainingDataRow } from "../../extensions/llm-extraction/training-capture.js";

export interface ITrainingStore {
  /** Save a training pair to the database. */
  saveTrainingPair(pair: TrainingPair): Promise<void>;

  /** Get counts of training data per task type (quality >= 0.7). */
  getTrainingDataCount(): Promise<TrainingDataCounts>;

  /** Get detailed training data statistics. */
  getTrainingDataStats(): Promise<TrainingDataStats>;

  /** Get training data rows for export. */
  getTrainingData(
    taskType: "extraction" | "summarization" | "dialogue",
    minQuality?: number,
    limit?: number,
    offset?: number,
  ): Promise<TrainingDataRow[]>;
}
