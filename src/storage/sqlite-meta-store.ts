/**
 * SQLite-backed metadata key-value store.
 * Replaces the meta.json file for index metadata.
 * Implements IMetaStore for pluggable storage support.
 */

import type Database from "better-sqlite3";
import type { IMetaStore } from "./interfaces/index.js";

export class SqliteMetaStore implements IMetaStore {
  private stmts: {
    get: Database.Statement;
    set: Database.Statement;
    remove: Database.Statement;
    getAll: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      get: db.prepare("SELECT value FROM index_meta WHERE key = ?"),
      set: db.prepare("INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)"),
      remove: db.prepare("DELETE FROM index_meta WHERE key = ?"),
      getAll: db.prepare("SELECT key, value FROM index_meta"),
    };
  }

  /**
   * Get a metadata value by key.
   */
  async get(key: string): Promise<string | undefined> {
    const row = this.stmts.get.get(key) as { value: string } | undefined;
    return row?.value;
  }

  /**
   * Get a metadata value parsed as JSON.
   */
  async getJson<T>(key: string): Promise<T | undefined> {
    const value = await this.get(key);
    if (value === undefined) return undefined;
    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }

  /**
   * Set a metadata value.
   */
  async set(key: string, value: string): Promise<void> {
    this.stmts.set.run(key, value);
  }

  /**
   * Set a metadata value as JSON.
   */
  async setJson(key: string, value: unknown): Promise<void> {
    this.stmts.set.run(key, JSON.stringify(value));
  }

  /**
   * Remove a metadata key.
   */
  async remove(key: string): Promise<void> {
    this.stmts.remove.run(key);
  }

  /**
   * Get all metadata as a record.
   */
  async getAll(): Promise<Record<string, string>> {
    const rows = this.stmts.getAll.all() as { key: string; value: string }[];
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }
}
