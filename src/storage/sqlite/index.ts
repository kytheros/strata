/**
 * SQLite storage factory.
 *
 * Creates a StorageContext backed by better-sqlite3. This is the default
 * storage backend for local/Node.js deployments.
 */

import { openDatabase } from "../database.js";
import { SqliteKnowledgeStore } from "../sqlite-knowledge-store.js";
import { SqliteDocumentStore } from "../sqlite-document-store.js";
import { SqliteEntityStore } from "../sqlite-entity-store.js";
import { SqliteSummaryStore } from "../sqlite-summary-store.js";
import { SqliteMetaStore } from "../sqlite-meta-store.js";
import type { StorageContext } from "../interfaces/index.js";
import type { GeminiEmbedder } from "../../extensions/embeddings/gemini-embedder.js";

export interface SqliteStorageOptions {
  dbPath?: string;
  embedder?: GeminiEmbedder | null;
}

/**
 * Create a StorageContext backed by better-sqlite3.
 *
 * Opens or creates a SQLite database at `dbPath` (defaults to ~/.strata/strata.db)
 * and returns all five store instances plus a close() method.
 */
export function createSqliteStorage(options: SqliteStorageOptions = {}): StorageContext {
  const db = openDatabase(options.dbPath);
  return {
    knowledge: new SqliteKnowledgeStore(db, options.embedder),
    documents: new SqliteDocumentStore(db),
    entities: new SqliteEntityStore(db),
    summaries: new SqliteSummaryStore(db),
    meta: new SqliteMetaStore(db),
    close: async () => { db.close(); },
  };
}
