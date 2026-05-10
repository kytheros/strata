/**
 * Postgres-backed training data store.
 *
 * Implements ITrainingStore for Postgres.
 * Port of training-capture.ts functions to async pg interface.
 */

import type { PgPool } from "./pg-types.js";
import type { ITrainingStore } from "../interfaces/training-store.js";
import type {
  TrainingPair,
  TrainingDataCounts,
  TrainingDataStats,
  TrainingDataRow,
} from "../../extensions/llm-extraction/training-capture.js";

export class PgTrainingStore implements ITrainingStore {
  constructor(private pool: PgPool) {}

  async saveTrainingPair(pair: TrainingPair): Promise<void> {
    await this.pool.query(
      `INSERT INTO training_data
        (task_type, input_text, output_json, model_used, quality_score, heuristic_diverged, created_at, reasoning_trace)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        pair.taskType,
        pair.inputText,
        pair.outputJson,
        pair.modelUsed,
        pair.qualityScore,
        pair.heuristicDiverged ? 1 : 0,
        Date.now(),
        pair.reasoningTrace ?? null,
      ]
    );
  }

  async getTrainingDataCount(): Promise<TrainingDataCounts> {
    const { rows } = await this.pool.query<{ task_type: string; count: string }>(
      `SELECT task_type, COUNT(*) as count
       FROM training_data
       WHERE quality_score >= 0.7
       GROUP BY task_type`
    );

    return {
      extraction: Number(rows.find((r) => r.task_type === "extraction")?.count ?? 0),
      summarization: Number(rows.find((r) => r.task_type === "summarization")?.count ?? 0),
      dialogue: Number(rows.find((r) => r.task_type === "dialogue")?.count ?? 0),
      conflict: Number(rows.find((r) => r.task_type === "conflict")?.count ?? 0),
    };
  }

  async getTrainingDataStats(): Promise<TrainingDataStats> {
    const { rows } = await this.pool.query<{
      task_type: string;
      total: string;
      high_quality: string;
      medium_quality: string;
      heuristic_diverged: string;
    }>(
      `SELECT
        task_type,
        COUNT(*) as total,
        SUM(CASE WHEN quality_score >= 0.9 THEN 1 ELSE 0 END) as high_quality,
        SUM(CASE WHEN quality_score >= 0.7 AND quality_score < 0.9 THEN 1 ELSE 0 END) as medium_quality,
        SUM(CASE WHEN heuristic_diverged = 1 THEN 1 ELSE 0 END) as heuristic_diverged
      FROM training_data
      GROUP BY task_type`
    );

    const extractionRow = rows.find((r) => r.task_type === "extraction");
    const summarizationRow = rows.find((r) => r.task_type === "summarization");
    const dialogueRow = rows.find((r) => r.task_type === "dialogue");
    const conflictRow = rows.find((r) => r.task_type === "conflict");

    const { rows: lastRows } = await this.pool.query<{ last_at: string | null }>(
      "SELECT MAX(created_at) as last_at FROM training_data"
    );

    return {
      extraction: {
        total: Number(extractionRow?.total ?? 0),
        highQuality: Number(extractionRow?.high_quality ?? 0),
        mediumQuality: Number(extractionRow?.medium_quality ?? 0),
        heuristicDiverged: Number(extractionRow?.heuristic_diverged ?? 0),
      },
      summarization: {
        total: Number(summarizationRow?.total ?? 0),
        highQuality: Number(summarizationRow?.high_quality ?? 0),
        mediumQuality: Number(summarizationRow?.medium_quality ?? 0),
        heuristicDiverged: Number(summarizationRow?.heuristic_diverged ?? 0),
      },
      dialogue: {
        total: Number(dialogueRow?.total ?? 0),
        highQuality: Number(dialogueRow?.high_quality ?? 0),
        mediumQuality: Number(dialogueRow?.medium_quality ?? 0),
        heuristicDiverged: Number(dialogueRow?.heuristic_diverged ?? 0),
      },
      conflict: {
        total: Number(conflictRow?.total ?? 0),
        highQuality: Number(conflictRow?.high_quality ?? 0),
        mediumQuality: Number(conflictRow?.medium_quality ?? 0),
        heuristicDiverged: Number(conflictRow?.heuristic_diverged ?? 0),
      },
      lastCapturedAt: lastRows[0]?.last_at ? Number(lastRows[0].last_at) : null,
    };
  }

  async getTrainingData(
    taskType: "extraction" | "summarization" | "dialogue" | "conflict",
    minQuality: number = 0.7,
    limit: number = 1000,
    offset: number = 0
  ): Promise<TrainingDataRow[]> {
    const { rows } = await this.pool.query<{
      id: string;
      task_type: string;
      input_text: string;
      output_json: string;
      model_used: string;
      quality_score: number;
      heuristic_diverged: number;
      created_at: string;
      reasoning_trace: string | null;
    }>(
      `SELECT id, task_type, input_text, output_json, model_used, quality_score, heuristic_diverged, created_at, reasoning_trace
       FROM training_data
       WHERE task_type = $1 AND quality_score >= $2
       ORDER BY created_at ASC
       LIMIT $3 OFFSET $4`,
      [taskType, minQuality, limit, offset]
    );

    return rows.map((row) => ({
      id: Number(row.id),
      taskType: row.task_type,
      inputText: row.input_text,
      outputJson: row.output_json,
      modelUsed: row.model_used,
      qualityScore: row.quality_score,
      heuristicDiverged: row.heuristic_diverged === 1,
      createdAt: Number(row.created_at),
      reasoningTrace: row.reasoning_trace,
    }));
  }
}
