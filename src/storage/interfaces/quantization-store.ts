/**
 * IQuantizationStore interface: async-first contract for quantization migration state.
 *
 * Extracted from quantization/migration.ts to allow Postgres (and future) adapters
 * without direct db.prepare() calls.
 */

export interface QuantizationMigrationState {
  id: string;
  current_bit_width: number | null;
  target_bit_width: number | null;
  total_vectors: number;
  migrated_vectors: number;
  status: string;
  started_at: number | null;
  completed_at: number | null;
}

export interface EmbeddingRowForMigration {
  entry_id: string;
  embedding: Buffer;
  format: string;
}

export interface IQuantizationStore {
  /** Get all Float32 embeddings that need migration. */
  getUnquantizedEmbeddings(limit: number): Promise<EmbeddingRowForMigration[]>;

  /** Update an embedding row with quantized data. */
  saveQuantized(entryId: string, embedding: Buffer, format: string): Promise<void>;

  /** Get current migration state. */
  getMigrationState(): Promise<QuantizationMigrationState | null>;

  /** Upsert migration state fields. */
  upsertMigrationState(fields: Record<string, unknown>): Promise<void>;

  /** Get total embedding count. */
  getEmbeddingCount(): Promise<number>;

  /** Get count of Float32 (unmigrated) embeddings. */
  getFloat32Count(): Promise<number>;

  /** Update migration progress counter. */
  updateMigrationProgress(migratedCount: number): Promise<void>;
}
