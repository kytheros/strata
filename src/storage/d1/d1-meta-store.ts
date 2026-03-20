/**
 * D1-backed metadata key-value store.
 *
 * Implements IMetaStore using Cloudflare D1 async APIs.
 * Mirrors SqliteMetaStore method-for-method.
 */

import type { D1Database } from "./d1-types.js";
import type { IMetaStore } from "../interfaces/index.js";

export class D1MetaStore implements IMetaStore {
  constructor(private db: D1Database) {}

  async get(key: string): Promise<string | undefined> {
    const row = await this.db
      .prepare("SELECT value FROM index_meta WHERE key = ?")
      .bind(key)
      .first<{ value: string }>();
    return row?.value ?? undefined;
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
    await this.db
      .prepare("INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)")
      .bind(key, value)
      .run();
  }

  async setJson(key: string, value: unknown): Promise<void> {
    await this.set(key, JSON.stringify(value));
  }

  async remove(key: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM index_meta WHERE key = ?")
      .bind(key)
      .run();
  }

  async getAll(): Promise<Record<string, string>> {
    const result = await this.db
      .prepare("SELECT key, value FROM index_meta")
      .all<{ key: string; value: string }>();

    const out: Record<string, string> = {};
    for (const row of result.results) {
      out[row.key] = row.value;
    }
    return out;
  }
}
