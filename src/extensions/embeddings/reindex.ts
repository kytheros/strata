/**
 * Resumable, non-destructive knowledge-entry reindex.
 *
 * Re-embeds knowledge entries that lack a vector under the currently active
 * embedding model. Old-model rows are NEVER deleted — providers coexist in
 * the (entry_id, model) composite PK. Document chunks and knowledge_turn_embeddings
 * are excluded (they have separate embedding pipelines).
 *
 * Progress is tracked in migration_state (id='embeddings-reindex') so the
 * operation is resumable after a restart.
 */

import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../vector-search/embedding-provider.js";
import { resolveActiveEmbeddingModel } from "./active-model.js";
import { encodeEmbeddingFor } from "../../storage/sqlite-knowledge-store.js";

const BATCH_SIZE = 50;

export interface ReindexResult {
  embedded: number;
  skipped: number;
  failed: number;
}

/**
 * Re-embed knowledge entries under the active model.
 *
 * For each entry that has NO vector under activeModel, embed its
 * summary + details text and upsert the result. Old-model rows are
 * retained (never deleted). Document chunks and turn vectors excluded.
 *
 * Progress is persisted in migration_state id='embeddings-reindex' for
 * resumability.
 */
export async function reindexEmbeddings(
  db: Database.Database,
  provider: EmbeddingProvider
): Promise<ReindexResult> {
  const active = resolveActiveEmbeddingModel();
  const activeModel = active.model;

  // Ensure migration_state row exists (idempotent)
  db.prepare(`
    INSERT OR IGNORE INTO migration_state (id, status, started_at)
    VALUES ('embeddings-reindex', 'running', ?)
  `).run(Date.now());
  db.prepare(`
    UPDATE migration_state SET status = 'running', started_at = ? WHERE id = 'embeddings-reindex'
  `).run(Date.now());

  // Find entries that have NO vector under the active model.
  // We never delete old rows — old-model vectors coexist.
  const selectBatch = db.prepare(`
    SELECT id, summary, details
    FROM knowledge
    WHERE id NOT IN (
      SELECT entry_id FROM embeddings WHERE model = ?
    )
    LIMIT ?
  `);

  const upsertEmbedding = db.prepare(`
    INSERT OR REPLACE INTO embeddings (entry_id, embedding, model, created_at, format)
    VALUES (?, ?, ?, ?, ?)
  `);

  let embedded = 0;
  let skipped = 0;
  let failed = 0;

  // Process in batches until no unembedded entries remain
  while (true) {
    const batch = selectBatch.all(activeModel, BATCH_SIZE) as Array<{
      id: string;
      summary: string;
      details: string;
    }>;

    if (batch.length === 0) break;

    for (const row of batch) {
      try {
        const text = `${row.summary} ${row.details}`;
        const vec = await provider.embed(text, "RETRIEVAL_DOCUMENT");
        const { buf, format } = encodeEmbeddingFor(vec, provider.supportsQuantization);
        upsertEmbedding.run(row.id, buf, activeModel, Date.now(), format);
        embedded++;
      } catch (err) {
        console.error(`[strata] reindex: failed to embed entry ${row.id}:`, err);
        failed++;
        // Skip this entry so we don't loop forever
        // Insert a sentinel? No — just skip. Next batch re-query will re-find it.
        // To avoid infinite loop on persistent failures, we break if too many fail.
        if (failed > 10 && failed > embedded) {
          console.error("[strata] reindex: too many failures, aborting.");
          break;
        }
      }
    }
    skipped = 0; // already-embedded entries never appear in the query

    // Update progress
    db.prepare(`
      UPDATE migration_state SET migrated_vectors = ? WHERE id = 'embeddings-reindex'
    `).run(embedded);
  }

  db.prepare(`
    UPDATE migration_state SET status = 'complete', completed_at = ? WHERE id = 'embeddings-reindex'
  `).run(Date.now());

  return { embedded, skipped, failed };
}
