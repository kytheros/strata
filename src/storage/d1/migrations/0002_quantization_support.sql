-- TurboQuant quantization support for D1 embeddings
-- Adds format tracking column and migration state table

ALTER TABLE embeddings ADD COLUMN format TEXT NOT NULL DEFAULT 'float32';

CREATE TABLE IF NOT EXISTS migration_state (
  id TEXT PRIMARY KEY DEFAULT 'quantization',
  current_bit_width INTEGER,
  target_bit_width INTEGER,
  total_vectors INTEGER DEFAULT 0,
  migrated_vectors INTEGER DEFAULT 0,
  status TEXT DEFAULT 'idle',
  started_at INTEGER,
  completed_at INTEGER
);
