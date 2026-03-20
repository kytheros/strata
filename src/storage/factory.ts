/**
 * Storage factory: routes to the appropriate storage backend by adapter type.
 *
 * Currently supports:
 *   - "sqlite" (default): better-sqlite3, local/Node.js
 *   - "d1": Cloudflare D1, Workers runtime
 */

import type { StorageContext, StorageOptions } from "./interfaces/index.js";
import { createSqliteStorage } from "./sqlite/index.js";

/**
 * Create a StorageContext for the specified adapter.
 *
 * Defaults to SQLite if no adapter is specified.
 * The D1 adapter is loaded dynamically to avoid bundling Cloudflare types
 * in Node.js deployments.
 */
export async function createStorage(options: StorageOptions): Promise<StorageContext> {
  if (options.adapter === "d1") {
    // Dynamic import keeps D1 code tree-shakeable from the main entry point
    const { createD1Storage } = await import("./d1/index.js");
    return createD1Storage(options);
  }

  return createSqliteStorage({
    dbPath: options.dbPath,
    embedder: options.embedder,
  });
}
