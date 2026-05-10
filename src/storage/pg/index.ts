/**
 * Postgres storage factory.
 *
 * Creates a StorageContext backed by Postgres. This is the third storage
 * backend for Cloud SQL / GCP multi-tenant deployments.
 *
 * Usage:
 *   import { createPgStorage } from "strata-mcp/storage/pg";
 *   const storage = await createPgStorage({
 *     connectionString: process.env.DATABASE_URL!,
 *     userId: "user-123",
 *   });
 */

import type { StorageContext, StorageOptions } from "../interfaces/index.js";
import { createPool, type PgPool, type PgConfig } from "./pg-types.js";
import { createSchema, PG_SCHEMA_VERSION } from "./schema.js";
import { PgKnowledgeStore } from "./pg-knowledge-store.js";
import { PgDocumentStore } from "./pg-document-store.js";
import { PgEntityStore } from "./pg-entity-store.js";
import { PgSummaryStore } from "./pg-summary-store.js";
import { PgMetaStore } from "./pg-meta-store.js";

/** Options for creating a Postgres-backed StorageContext. */
export interface PgStorageOptions {
  /**
   * Pre-created pg.Pool to share across users. When provided, this factory
   * does NOT call pool.end() on close() — the caller owns the pool lifecycle.
   * Use this path for multi-tenant deployments where one pool serves all users.
   */
  pool?: PgPool;
  /** Connection string — used only when `pool` is not provided. */
  connectionString?: string;
  userId: string;
  maxConnections?: number;
  embedder?: { embed(text: string, taskType: string): Promise<Float32Array> } | null;
}

/**
 * Create a StorageContext backed by Postgres.
 *
 * Accepts either PgStorageOptions directly or a StorageOptions from the factory.
 * Initializes the schema if needed (checks index_meta for schema version),
 * then constructs all 5 Pg store classes.
 *
 * Pool ownership:
 *   - PgStorageOptions with `pool` set: caller owns the pool; close() is a no-op.
 *   - PgStorageOptions with `connectionString`: factory creates and owns the pool;
 *     close() calls pool.end().
 *   - StorageOptions from factory: factory creates and owns the pool.
 */
export async function createPgStorage(options: PgStorageOptions | StorageOptions): Promise<StorageContext> {
  let pool: PgPool;
  let userId: string;
  let embedder: { embed(text: string, taskType: string): Promise<Float32Array> } | null | undefined;
  let ownPool = false;

  if ("userId" in options && "pool" in options && options.pool) {
    // Caller-owned shared pool (multi-tenant transport path)
    pool = options.pool;
    userId = options.userId;
    embedder = options.embedder;
    ownPool = false; // caller is responsible for pool.end()
  } else if ("connectionString" in options && options.connectionString) {
    // Direct PgStorageOptions with connection string — factory creates pool
    pool = createPool({
      connectionString: options.connectionString,
      maxConnections: options.maxConnections,
    });
    userId = options.userId;
    embedder = options.embedder;
    ownPool = true;
  } else {
    // StorageOptions from factory (adapter === "pg", pgConnectionString set by factory.ts)
    const storageOpts = options as import("../interfaces/index.js").StorageOptions;
    if (!storageOpts.pgConnectionString) {
      throw new Error("Postgres adapter requires pgConnectionString in StorageOptions.");
    }
    pool = createPool({
      connectionString: storageOpts.pgConnectionString,
      maxConnections: storageOpts.pgMaxConnections,
    });
    userId = storageOpts.userId ?? "default";
    embedder = storageOpts.embedder;
    ownPool = true;
  }

  // Initialize schema if needed
  await createSchema(pool);

  const meta = new PgMetaStore(pool);

  return {
    knowledge: new PgKnowledgeStore(pool, userId, embedder),
    documents: new PgDocumentStore(pool, userId),
    entities: new PgEntityStore(pool, userId),
    summaries: new PgSummaryStore(pool, userId),
    meta,
    close: async () => {
      if (ownPool) {
        await pool.end();
      }
    },
  };
}

// Re-export types and classes for consumer convenience
export { createPool, type PgPool, type PgConfig } from "./pg-types.js";
export { createSchema, dropSchema, PG_SCHEMA_VERSION } from "./schema.js";
export { PgDocumentStore } from "./pg-document-store.js";
export { PgKnowledgeStore } from "./pg-knowledge-store.js";
export { PgEventStore } from "./pg-event-store.js";
export { PgEntityStore } from "./pg-entity-store.js";
export { PgSummaryStore } from "./pg-summary-store.js";
export { PgMetaStore } from "./pg-meta-store.js";
export { PgDocumentChunkStore } from "./pg-document-chunk-store.js";
export { PgVectorSearch, type PgVectorSearchResult } from "./pg-vector-search.js";
export { PgTrainingStore } from "./pg-training-store.js";
export { PgEvidenceGapStore } from "./pg-evidence-gap-store.js";
export { PgQuantizationStore } from "./pg-quantization-store.js";
