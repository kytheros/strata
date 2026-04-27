/**
 * Postgres connection types and pool factory.
 *
 * Wraps the `pg` module with Strata-specific configuration defaults.
 * Provides a minimal PgConfig interface for constructing connection pools.
 */

import pg from "pg";

export type PgPool = pg.Pool;
export type PgClient = pg.PoolClient;

/** Configuration for creating a Postgres connection pool. */
export interface PgConfig {
  connectionString: string;
  maxConnections?: number;
  idleTimeoutMillis?: number;
}

/**
 * Create a pg.Pool with Strata defaults.
 *
 * @param config.connectionString - Postgres connection URL
 * @param config.maxConnections - Max pool size (default: 20)
 * @param config.idleTimeoutMillis - Idle connection timeout (default: 30000)
 */
export function createPool(config: PgConfig): PgPool {
  return new pg.Pool({
    connectionString: config.connectionString,
    max: config.maxConnections ?? 20,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 30000,
  });
}
