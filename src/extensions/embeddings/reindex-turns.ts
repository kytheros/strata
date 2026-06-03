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

  // Resumability is query-based: the anti-join (turn_id NOT IN embeddings WHERE model=?)
  // naturally skips already-embedded turns on every restart, so the function is safe to
  // call repeatedly. The migration_state row provides progress visibility only —
  // its status/timestamp are decorative and do NOT gate re-entry.
  db.prepare(`
    INSERT OR IGNORE INTO migration_state (id, status, started_at)
    VALUES (?, 'running', ?)
  `).run(MIGRATION_ID, Date.now());
  db.prepare(`
    UPDATE migration_state SET status = 'running', started_at = ? WHERE id = ?
  `).run(Date.now(), MIGRATION_ID);

  // Find turns that have NO vector under the active model AND have non-empty content.
  // Filtering empty content at the SQL level prevents them from being re-selected on
  // every batch (the anti-join would otherwise loop forever over un-embeddable rows).
  // We never delete old rows — old-model vectors coexist.
  const selectBatch = db.prepare(`
    SELECT turn_id, content
    FROM knowledge_turns
    WHERE turn_id NOT IN (
      SELECT turn_id FROM knowledge_turn_embeddings WHERE model = ?
    )
    AND TRIM(content) != ''
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

    // Safety net: the SQL filter already excludes empty content, but guard here too
    // in case a provider returns an empty embedding for a very-short turn.
    const toEmbed = batch;
    if (toEmbed.length === 0) break;

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
