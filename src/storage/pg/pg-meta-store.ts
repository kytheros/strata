/**
 * Postgres-backed metadata key-value store.
 *
 * Implements IMetaStore using pg Pool async APIs.
 * Direct port from D1MetaStore with Postgres syntax.
 */

import type { PgPool } from "./pg-types.js";
import type { IMetaStore } from "../interfaces/index.js";

export class PgMetaStore implements IMetaStore {
  constructor(private pool: PgPool) {}

  async get(key: string): Promise<string | undefined> {
    const { rows } = await this.pool.query<{ value: string }>(
      "SELECT value FROM index_meta WHERE key = $1",
      [key]
    );
    return rows.length > 0 ? rows[0].value : undefined;
  }

  async getJson<T>(key: string): Promise<T | undefined> {
    const value = await this.get(key);
    if (value === undefined) return undefined;
    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO index_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
      [key, value]
    );
  }

  async setJson(key: string, value: unknown): Promise<void> {
    await this.set(key, JSON.stringify(value));
  }

  async remove(key: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM index_meta WHERE key = $1",
      [key]
    );
  }

  async getAll(): Promise<Record<string, string>> {
    const { rows } = await this.pool.query<{ key: string; value: string }>(
      "SELECT key, value FROM index_meta"
    );

    const out: Record<string, string> = {};
    for (const row of rows) {
      out[row.key] = row.value;
    }
    return out;
  }
}
