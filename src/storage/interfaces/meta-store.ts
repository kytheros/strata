/**
 * IMetaStore interface: async-first contract for key-value metadata persistence.
 *
 * Extracted from SqliteMetaStore public methods. All return types are Promise<T>
 * so that both synchronous (SQLite) and asynchronous (D1) adapters can implement them.
 */

export interface IMetaStore {
  get(key: string): Promise<string | undefined>;
  getJson<T>(key: string): Promise<T | undefined>;
  set(key: string, value: string): Promise<void>;
  setJson(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  getAll(): Promise<Record<string, string>>;
}
