/**
 * LRU database connection pool for multi-tenant Strata deployments.
 *
 * Manages per-user SQLite databases under a base directory:
 *   {baseDir}/{userId}/strata.db
 *
 * Each user gets their own database, IndexManager, and associated stores.
 * The pool keeps at most `maxOpen` databases open simultaneously, evicting
 * the least-recently-used entries when the limit is reached.
 *
 * userId MUST be a valid UUID to prevent path traversal attacks.
 */

import { join } from "path";
import type Database from "better-sqlite3";
import { openDatabase } from "./database.js";
import { SqliteIndexManager } from "../indexing/sqlite-index-manager.js";

/** UUID v4 pattern — strict validation to prevent path traversal */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PoolEntry {
  db: Database.Database;
  indexManager: SqliteIndexManager;
}

interface InternalEntry extends PoolEntry {
  userId: string;
  lastAccess: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  refCount: number;
}

export interface PoolStats {
  open: number;
  maxOpen: number;
  hits: number;
  misses: number;
}

export interface PoolOptions {
  maxOpen?: number;
  idleTimeoutMs?: number;
}

export class DatabasePool {
  private readonly baseDir: string;
  private readonly maxOpen: number;
  private readonly idleTimeoutMs: number;

  /** LRU-ordered map: iteration order = insertion/access order */
  private readonly entries = new Map<string, InternalEntry>();

  private hits = 0;
  private misses = 0;
  private closed = false;

  constructor(baseDir: string, options?: PoolOptions) {
    this.baseDir = baseDir;
    this.maxOpen = options?.maxOpen ?? 200;
    this.idleTimeoutMs = options?.idleTimeoutMs ?? 300_000;
  }

  /**
   * Acquire a database and IndexManager for the given userId.
   *
   * On cache hit: returns the existing entry (LRU promotion).
   * On cache miss: opens a new database, evicting LRU if pool is full.
   *
   * @throws Error if userId is not a valid UUID
   */
  acquire(userId: string): PoolEntry {
    this.validateUserId(userId);

    const existing = this.entries.get(userId);
    if (existing) {
      this.hits++;
      // Cancel any pending idle eviction
      if (existing.idleTimer) {
        clearTimeout(existing.idleTimer);
        existing.idleTimer = null;
      }
      existing.lastAccess = Date.now();
      existing.refCount++;
      // Promote to most-recently-used by re-inserting
      this.entries.delete(userId);
      this.entries.set(userId, existing);
      return { db: existing.db, indexManager: existing.indexManager };
    }

    // Cache miss — open new database
    this.misses++;
    this.evictIfNeeded();

    const dbPath = join(this.baseDir, userId, "strata.db");
    const indexManager = new SqliteIndexManager(dbPath);

    const entry: InternalEntry = {
      userId,
      db: indexManager.db,
      indexManager,
      lastAccess: Date.now(),
      idleTimer: null,
      refCount: 1,
    };

    this.entries.set(userId, entry);
    return { db: entry.db, indexManager: entry.indexManager };
  }

  /**
   * Release a database back to the pool, marking it idle.
   * Starts the idle eviction timer.
   */
  release(userId: string): void {
    const entry = this.entries.get(userId);
    if (!entry) return;

    entry.refCount = Math.max(0, entry.refCount - 1);

    // Start idle eviction timer
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
    }
    entry.idleTimer = setTimeout(() => {
      this.evict(userId);
    }, this.idleTimeoutMs);
  }

  /**
   * Close all open databases and clear the pool.
   * Call this on process shutdown.
   */
  close(): void {
    this.closed = true;
    for (const [userId, entry] of this.entries) {
      this.closeEntry(entry);
    }
    this.entries.clear();
  }

  /**
   * Get pool statistics.
   */
  get stats(): PoolStats {
    return {
      open: this.entries.size,
      maxOpen: this.maxOpen,
      hits: this.hits,
      misses: this.misses,
    };
  }

  /**
   * Get details for all entries in the pool (for admin endpoint).
   */
  getEntries(): Array<{ userId: string; lastAccess: number; alive: boolean }> {
    const result: Array<{ userId: string; lastAccess: number; alive: boolean }> = [];
    for (const [userId, entry] of this.entries) {
      result.push({
        userId,
        lastAccess: entry.lastAccess,
        alive: entry.db.open,
      });
    }
    return result;
  }

  // ── Private helpers ────────────────────────────────────────────────

  private validateUserId(userId: string): void {
    if (!UUID_RE.test(userId)) {
      throw new Error(
        `Invalid userId: must be UUID format (got "${userId.slice(0, 50)}")`
      );
    }
  }

  /**
   * Evict the least-recently-used entry if pool is at capacity.
   * The LRU entry is the first in the Map iteration order.
   */
  private evictIfNeeded(): void {
    while (this.entries.size >= this.maxOpen) {
      // Map iteration gives insertion order — first entry is LRU
      const first = this.entries.keys().next();
      if (first.done) break;
      this.evict(first.value);
    }
  }

  /**
   * Evict a specific entry: close its database and remove from pool.
   */
  private evict(userId: string): void {
    const entry = this.entries.get(userId);
    if (!entry) return;
    this.closeEntry(entry);
    this.entries.delete(userId);
  }

  /**
   * Close an entry's database and cancel its idle timer.
   */
  private closeEntry(entry: InternalEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    try {
      entry.indexManager.close();
    } catch {
      // Ignore errors during cleanup (e.g., already closed)
    }
  }
}
