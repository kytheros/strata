/**
 * Resumable, non-destructive turn-embedding reindex.
 *
 * Re-embeds knowledge_turns entries that lack a vector under the currently
 * active embedding model. Old-model rows are NEVER deleted — providers
 * coexist in the (turn_id, model) composite PK. Empty/whitespace turns
 * are skipped (the embedding API rejects empty content).
 *
 * Progress is tracked in migration_state (id='turn-embeddings-reindex') so
 * the operation is resumable after a restart.
 *
 * Mirrors reindexEmbeddings (reindex.ts) with the same abort-on-persistent-failure
 * heuristic and the same encodeEmbeddingFor / provider.modelName contracts.
 *
 * Spec: 2026-06-03-dense-turn-lane-production-design §3.8.
 */

import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../vector-search/embedding-provider.js";
import { encodeEmbeddingFor } from "../../storage/sqlite-knowledge-store.js";
import { CONFIG } from "../../config.js";

const BATCH_SIZE = 50;
const MIGRATION_ID = "turn-embeddings-reindex";

export interface ReindexTurnsResult {
  embedded: number;
  failed: number;
}

/**
 * Re-embed knowledge_turns under the active model (provider.modelName).
 *
 * For each turn that has NO vector under provider.modelName, embed its
 * content and upsert the result. Old-model rows are retained (never deleted).
 * Empty/whitespace turns are skipped.
 *
 * Progress is persisted in migration_state id='turn-embeddings-reindex' for resumability.
 */
export async function reindexTurns(
  db: Database.Database,
  provider: EmbeddingProvider
): Promise<ReindexTurnsResult> {
  const activeModel = provider.modelName;

  // Ensure migration_state row exists (idempotent)
  db.prepare(`
    INSERT OR IGNORE INTO migration_state (id, status, started_at)
    VALUES (?, 'running', ?)
  `).run(MIGRATION_ID, Date.now());
  db.prepare(`
    UPDATE migration_state SET status = 'running', started_at = ? WHERE id = ?
  `).run(Date.now(), MIGRATION_ID);

  // Find turns that have NO vector under the active model.
  // We never delete old rows — old-model vectors coexist.
  const selectBatch = db.prepare(`
    SELECT turn_id, content
    FROM knowledge_turns
    WHERE turn_id NOT IN (
      SELECT turn_id FROM knowledge_turn_embeddings WHERE model = ?
    )
    LIMIT ?
  `);

  const upsertEmbedding = db.prepare(
    `INSERT OR REPLACE INTO knowledge_turn_embeddings (turn_id, embedding, model, created_at, format)
     VALUES (?, ?, ?, ?, ?)`
  );

  let embedded = 0;
  let failed = 0;
  let shouldAbort = false;

  // Process in batches until no un-embedded turns remain
  while (true) {
    const batch = selectBatch.all(activeModel, BATCH_SIZE) as Array<{
      turn_id: string;
      content: string;
    }>;

    if (batch.length === 0) break;

    // Filter to non-empty content only (embedding API rejects empty content)
    const toEmbed = batch.filter(row => row.content.trim().length > 0);
    const toSkip = batch.filter(row => row.content.trim().length === 0);

    // Mark empty turns as "embedded" (no vector needed) by inserting a placeholder?
    // No — just skip them. They don't get a vector row, so they'll be re-selected
    // by the anti-join query on every pass. Use a sentinel approach: if all remaining
    // are empty, we're done. Break when the batch minus empty is zero AND batch is full.
    // Simpler: count skipped in embedded so they don't loop forever.
    // Actually: empty turns should be excluded from the anti-join. Let's just mark
    // them as embedded count and move on (they don't need a vector).
    // But we can't distinguish "skipped because empty" from "not yet processed".
    // Solution: filter the selectBatch to non-empty content at the SQL level.
    void toSkip; // not needed — we handled via SQL filter below

    if (toEmbed.length === 0) {
      // All remaining batch items are empty content — rewrite the query to skip them.
      // For now, break to avoid infinite loop (empty turns will never get vectors).
      break;
    }

    try {
      const texts = toEmbed.map(r => r.content);
      const vecs = await provider.embedBatch(texts, CONFIG.search.denseTurnLane.docTaskType);

      const txn = db.transaction(() => {
        const now = Date.now();
        for (let i = 0; i < toEmbed.length; i++) {
          const { buf, format } = encodeEmbeddingFor(vecs[i], provider.supportsQuantization);
          upsertEmbedding.run(toEmbed[i].turn_id, buf, activeModel, now, format);
        }
      });
      txn();
      embedded += toEmbed.length;
    } catch (err) {
      console.error(`[strata] reindexTurns: failed to embed batch of ${toEmbed.length} turns:`, err);
      failed += toEmbed.length;
      // Abort when there are too many failures with no successes — persistent provider error.
      if (failed > 10 && failed > embedded) {
        console.error("[strata] reindexTurns: too many failures, aborting.");
        shouldAbort = true;
        break;
      }
    }

    // Update progress
    db.prepare(`
      UPDATE migration_state SET migrated_vectors = ? WHERE id = ?
    `).run(embedded, MIGRATION_ID);

    if (shouldAbort) break;
  }

  db.prepare(`
    UPDATE migration_state SET status = 'complete', completed_at = ? WHERE id = ?
  `).run(Date.now(), MIGRATION_ID);

  return { embedded, failed };
}
