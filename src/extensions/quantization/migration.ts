/**
 * Background migration worker: converts Float32 embeddings to quantized format.
 *
 * Processes vectors in batches, verifies reconstruction quality before
 * overwriting, and tracks progress in the migration_state table.
 * Resumable: picks up where it left off after restart.
 */

import type Database from "better-sqlite3";
import { CONFIG } from "../../config.js";
import { quantize, dequantize } from "./turbo-quant.js";
import type { BitWidth } from "./lloyd-max.js";

interface EmbeddingRow {
  entry_id: string;
  embedding: Buffer;
  format: string;
}

export interface MigrationResult {
  migrated: number;
  skipped: number;
  failed: number;
  total: number;
}

export class MigrationWorker {
  private batchSize: number;
  private verifyThreshold: number;

  constructor(
    private db: Database.Database,
    private targetBitWidth: BitWidth = 4,
  ) {
    this.batchSize = CONFIG.quantization.migrationBatchSize;
    this.verifyThreshold = CONFIG.quantization.migrationVerifyThreshold;
  }

  /** Run the migration. Processes all Float32 vectors in batches. */
  async run(): Promise<MigrationResult> {
    const targetFormat = `tq${this.targetBitWidth}`;
    let migrated = 0;
    let skipped = 0;
    let failed = 0;

    // Count total and remaining
    const totalRow = this.db.prepare("SELECT COUNT(*) as count FROM embeddings").get() as { count: number };
    const remainingRow = this.db.prepare(
      "SELECT COUNT(*) as count FROM embeddings WHERE format = 'float32'"
    ).get() as { count: number };

    const total = totalRow.count;
    const alreadyQuantized = total - remainingRow.count;
    skipped = alreadyQuantized;

    // Update migration state
    this.upsertState({
      total_vectors: total,
      migrated_vectors: alreadyQuantized,
      current_bit_width: this.targetBitWidth,
      target_bit_width: this.targetBitWidth,
      status: remainingRow.count > 0 ? "migrating" : "complete",
      started_at: Date.now(),
    });

    if (remainingRow.count === 0) {
      this.upsertState({ status: "complete", completed_at: Date.now() });
      return { migrated, skipped, failed, total };
    }

    // Process in batches
    const selectBatch = this.db.prepare(
      "SELECT entry_id, embedding, format FROM embeddings WHERE format = 'float32' LIMIT ?"
    );
    const updateRow = this.db.prepare(
      "UPDATE embeddings SET embedding = ?, format = ? WHERE entry_id = ?"
    );
    const updateProgress = this.db.prepare(
      "UPDATE migration_state SET migrated_vectors = ? WHERE id = 'quantization'"
    );

    let batch: EmbeddingRow[];
    do {
      batch = selectBatch.all(this.batchSize) as EmbeddingRow[];

      for (const row of batch) {
        try {
          // Deserialize original Float32
          const buf = row.embedding;
          const original = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);

          // Quantize
          const quantized = quantize(original, this.targetBitWidth);

          // Verify reconstruction quality
          const reconstructed = dequantize(quantized);
          const cosine = this.cosineSimilarity(original, reconstructed);

          if (cosine < this.verifyThreshold) {
            console.warn(`[strata] Migration: low reconstruction quality for ${row.entry_id} (cosine=${cosine.toFixed(4)}), skipping`);
            failed++;
            continue;
          }

          // Overwrite with quantized blob
          updateRow.run(Buffer.from(quantized), targetFormat, row.entry_id);
          migrated++;
        } catch (err) {
          console.error(`[strata] Migration failed for ${row.entry_id}:`, err);
          failed++;
        }
      }

      // Update progress
      updateProgress.run(alreadyQuantized + migrated);

      // Yield to event loop between batches
      await new Promise((resolve) => setTimeout(resolve, 0));
    } while (batch.length === this.batchSize);

    // Mark complete
    this.upsertState({
      status: "complete",
      migrated_vectors: skipped + migrated,
      completed_at: Date.now(),
    });

    return { migrated, skipped, failed, total };
  }

  /** Get current migration state */
  getState(): Record<string, unknown> | null {
    return this.db.prepare(
      "SELECT * FROM migration_state WHERE id = 'quantization'"
    ).get() as Record<string, unknown> | null;
  }

  private upsertState(fields: Record<string, unknown>): void {
    const existing = this.getState();
    if (!existing) {
      const cols = ["id", ...Object.keys(fields)];
      const vals = ["'quantization'", ...Object.keys(fields).map(() => "?")];
      this.db.prepare(
        `INSERT INTO migration_state (${cols.join(", ")}) VALUES (${vals.join(", ")})`
      ).run(...Object.values(fields));
    } else {
      const sets = Object.keys(fields).map((k) => `${k} = ?`).join(", ");
      this.db.prepare(
        `UPDATE migration_state SET ${sets} WHERE id = 'quantization'`
      ).run(...Object.values(fields));
    }
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    if (magA === 0 || magB === 0) return 0;
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  }
}
