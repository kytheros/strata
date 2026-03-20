/**
 * Minimal D1 type definitions for compile-time safety.
 *
 * These are local interfaces mirroring the Cloudflare D1 runtime API.
 * They are NOT imported from @cloudflare/workers-types to avoid pulling
 * Cloudflare dependencies into Node.js deployments.
 */

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
  raw<T = unknown[]>(): Promise<T[]>;
}

export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: { duration: number; rows_written?: number; rows_read?: number };
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(sql: string): Promise<{ count: number; duration: number }>;
}
