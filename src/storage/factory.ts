/**
 * Storage factory: routes to the appropriate storage backend by adapter type.
 *
 * Supports:
 *   - "sqlite" (default): better-sqlite3, local/Node.js
 *   - "d1": Cloudflare D1, Workers runtime
 *   - "pg": PostgreSQL via pg pool (Cloud SQL, self-hosted)
 */

import type { StorageContext, StorageOptions } from "./interfaces/index.js";
import { createSqliteStorage } from "./sqlite/index.js";

/**
 * Create a StorageContext for the specified adapter.
 *
 * Defaults to SQLite if no adapter is specified.
 * The D1 and Pg adapters are loaded dynamically to avoid bundling their
 * platform-specific dependencies in deployments that do not use them.
 */
export async function createStorage(options: StorageOptions): Promise<StorageContext> {
  if (options.adapter === "d1") {
    // Dynamic import keeps D1 code tree-shakeable from the main entry point
    const { createD1Storage } = await import("./d1/index.js");
    return createD1Storage(options);
  }

  if (options.adapter === "pg") {
    // Dynamic import keeps the `pg` dependency optional for non-Pg deployments
    const { createPgStorage } = await import("./pg/index.js");
    return createPgStorage(options);
  }

  return createSqliteStorage({
    dbPath: options.dbPath,
    embedder: options.embedder,
  });
}
