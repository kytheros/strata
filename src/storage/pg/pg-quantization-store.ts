/**
 * Postgres-backed quantization migration store.
 *
 * Implements IQuantizationStore for Postgres.
 * Port of quantization/migration.ts database operations to async pg interface.
 */

import type { PgPool } from "./pg-types.js";
import type {
  IQuantizationStore,
  QuantizationMigrationState,
  EmbeddingRowForMigration,
} from "../interfaces/quantization-store.js";

export class PgQuantizationStore implements IQuantizationStore {
  constructor(private pool: PgPool) {}

  async getUnquantizedEmbeddings(limit: number): Promise<EmbeddingRowForMigration[]> {
    const { rows } = await this.pool.query<{
      id: string;
      embedding: Buffer;
      format: string;
    }>(
      "SELECT id as entry_id, embedding, format FROM embeddings WHERE format = 'float32' LIMIT $1",
      [limit]
    );

    return rows.map((row) => ({
      entry_id: row.id,
      embedding: Buffer.isBuffer(row.embedding)
        ? row.embedding
        : Buffer.from(row.embedding as unknown as ArrayBuffer),
      format: row.format,
    }));
  }

  async saveQuantized(entryId: string, embedding: Buffer, format: string): Promise<void> {
    await this.pool.query(
      "UPDATE embeddings SET embedding = $1, format = $2 WHERE id = $3",
      [embedding, format, entryId]
    );
  }

  async getMigrationState(): Promise<QuantizationMigrationState | null> {
    const { rows } = await this.pool.query<{
      id: string;
      current_bit_width: number | null;
      target_bit_width: number | null;
      total_vectors: number;
      migrated_vectors: number;
      status: string;
      started_at: string | null;
      completed_at: string | null;
    }>(
      "SELECT * FROM migration_state WHERE id = 'quantization'"
    );

    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id,
      current_bit_width: row.current_bit_width,
      target_bit_width: row.target_bit_width,
      total_vectors: row.total_vectors,
      migrated_vectors: row.migrated_vectors,
      status: row.status,
      started_at: row.started_at ? Number(row.started_at) : null,
      completed_at: row.completed_at ? Number(row.completed_at) : null,
    };
  }

  async upsertMigrationState(fields: Record<string, unknown>): Promise<void> {
    const existing = await this.getMigrationState();
    if (!existing) {
      const cols = ["id", ...Object.keys(fields)];
      const placeholders = ["'quantization'", ...Object.keys(fields).map((_, i) => `$${i + 1}`)];
      await this.pool.query(
        `INSERT INTO migration_state (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`,
        Object.values(fields)
      );
    } else {
      const sets = Object.keys(fields).map((k, i) => `${k} = $${i + 1}`).join(", ");
      const values = [...Object.values(fields), "quantization"];
      await this.pool.query(
        `UPDATE migration_state SET ${sets} WHERE id = $${Object.keys(fields).length + 1}`,
        values
      );
    }
  }

  async getEmbeddingCount(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      "SELECT COUNT(*) as count FROM embeddings"
    );
    return Number(rows[0].count);
  }

  async getFloat32Count(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      "SELECT COUNT(*) as count FROM embeddings WHERE format = 'float32'"
    );
    return Number(rows[0].count);
  }

  async updateMigrationProgress(migratedCount: number): Promise<void> {
    await this.pool.query(
      "UPDATE migration_state SET migrated_vectors = $1 WHERE id = 'quantization'",
      [migratedCount]
    );
  }
}
