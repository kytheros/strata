/**
 * Embedding mismatch detection.
 *
 * Detects when the active embedding model has no vectors in the corpus but other
 * models do — indicating the user switched providers without reindexing. On mismatch,
 * the server logs a warning and degrades to FTS5-only mode (no semantic search).
 */

import type Database from "better-sqlite3";

export interface EmbeddingMismatchResult {
  /** True when there are vectors in the corpus but zero under the active model. */
  mismatch: boolean;
  /** Number of embeddings stored under the active model. */
  activeModelVectors: number;
  /** Number of embeddings stored under any other model. */
  otherModelVectors: number;
}

/**
 * Check whether the corpus has vectors for models other than the active one,
 * and the active model has none. This signals that the user switched providers
 * without running `strata embeddings reindex`.
 */
export function detectEmbeddingMismatch(
  db: Database.Database,
  activeModel: string
): EmbeddingMismatchResult {
  const active = (
    db.prepare("SELECT COUNT(*) c FROM embeddings WHERE model = ?").get(activeModel) as any
  ).c as number;
  const other = (
    db.prepare("SELECT COUNT(*) c FROM embeddings WHERE model != ?").get(activeModel) as any
  ).c as number;
  return {
    mismatch: active === 0 && other > 0,
    activeModelVectors: active,
    otherModelVectors: other,
  };
}
