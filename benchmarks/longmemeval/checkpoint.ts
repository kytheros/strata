/**
 * Per-question checkpoint helpers for LongMemEval benchmark resumability.
 *
 * Design: crash-safe JSONL append (one record per line). On restart, load the
 * completed Map and skip any question whose ID is already present.
 *
 * Spec: inline ticket — "resumability: per-question checkpointing + resume-on-restart"
 *
 * File layout:
 *   benchmarks/longmemeval/data/checkpoints/<runId>.jsonl
 *
 * The data/ directory is gitignored globally; checkpoint files are never committed.
 */

import { appendFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHECKPOINTS_DIR = join(__dirname, "data", "checkpoints");

/**
 * Returns the absolute path of the checkpoint file for a given runId.
 * Creates the checkpoints/ directory if it does not yet exist.
 */
export function checkpointPath(runId: string): string {
  mkdirSync(CHECKPOINTS_DIR, { recursive: true });
  return join(CHECKPOINTS_DIR, `${runId}.jsonl`);
}

/**
 * Synchronously appends one record as a JSON line to the checkpoint file.
 * Uses appendFileSync so the write is flushed immediately — crash-safe.
 * The record MUST have a `questionId` field for loadCompleted to index it.
 */
export function appendResult(runId: string, record: object): void {
  const path = checkpointPath(runId);
  appendFileSync(path, JSON.stringify(record) + "\n", "utf-8");
}

/**
 * Reads the checkpoint file and returns a Map keyed by `record.questionId`.
 * Returns an empty Map if the file does not exist.
 *
 * Corrupt/partial trailing lines (e.g. from a crash mid-write) are silently
 * skipped — JSON.parse failures are caught per-line and do not throw.
 */
export function loadCompleted(runId: string): Map<string, unknown> {
  const path = join(CHECKPOINTS_DIR, `${runId}.jsonl`);
  const result = new Map<string, unknown>();

  if (!existsSync(path)) {
    return result;
  }

  const raw = readFileSync(path, "utf-8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const qid = parsed["questionId"];
      if (typeof qid === "string") {
        result.set(qid, parsed);
      }
    } catch {
      // Corrupt / partial line — skip silently (crash safety)
    }
  }

  return result;
}
