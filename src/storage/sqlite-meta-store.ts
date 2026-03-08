/**
 * SQLite-backed metadata key-value store.
 * Replaces the meta.json file for index metadata.
 */

import type Database from "better-sqlite3";

export class SqliteMetaStore {
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
  get(key: string): string | undefined {
    const row = this.stmts.get.get(key) as { value: string } | undefined;
    return row?.value;
  }

  /**
   * Get a metadata value parsed as JSON.
   */
  getJson<T>(key: string): T | undefined {
    const value = this.get(key);
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
  set(key: string, value: string): void {
    this.stmts.set.run(key, value);
  }

  /**
   * Set a metadata value as JSON.
   */
  setJson(key: string, value: unknown): void {
    this.stmts.set.run(key, JSON.stringify(value));
  }

  /**
   * Remove a metadata key.
   */
  remove(key: string): void {
    this.stmts.remove.run(key);
  }

  /**
   * Get all metadata as a record.
   */
  getAll(): Record<string, string> {
    const rows = this.stmts.getAll.all() as { key: string; value: string }[];
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }
}
