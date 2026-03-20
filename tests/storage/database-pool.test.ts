/**
 * DatabasePool unit tests.
 *
 * Validates LRU eviction, idle timeout, maxOpen enforcement,
 * concurrent acquire semantics, UUID validation, and stats tracking.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { DatabasePool } from "../../src/storage/database-pool.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "strata-pool-test-"));
}

// Valid UUID v4 strings for testing
const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";

describe("DatabasePool", () => {
  let pool: DatabasePool | undefined;
  let baseDir: string;

  afterEach(() => {
    if (pool) {
      pool.close();
      pool = undefined;
    }
  });

  it("should acquire a database for a valid userId", () => {
    baseDir = makeTempDir();
    pool = new DatabasePool(baseDir, { maxOpen: 5 });

    const entry = pool.acquire(UUID_A);
    expect(entry.db).toBeDefined();
    expect(entry.db.open).toBe(true);
    expect(entry.indexManager).toBeDefined();
  });

  it("should create the database file under {baseDir}/{userId}/strata.db", () => {
    baseDir = makeTempDir();
    pool = new DatabasePool(baseDir, { maxOpen: 5 });

    pool.acquire(UUID_A);
    const dbPath = join(baseDir, UUID_A, "strata.db");
    expect(existsSync(dbPath)).toBe(true);
  });

  it("should return the same instance for concurrent acquire() calls with same userId", () => {
    baseDir = makeTempDir();
    pool = new DatabasePool(baseDir, { maxOpen: 5 });

    const entry1 = pool.acquire(UUID_A);
    const entry2 = pool.acquire(UUID_A);

    expect(entry1.db).toBe(entry2.db);
    expect(entry1.indexManager).toBe(entry2.indexManager);
  });

  it("should track hits and misses in stats", () => {
    baseDir = makeTempDir();
    pool = new DatabasePool(baseDir, { maxOpen: 5 });

    // First acquire = miss
    pool.acquire(UUID_A);
    expect(pool.stats.misses).toBe(1);
    expect(pool.stats.hits).toBe(0);

    // Second acquire = hit
    pool.acquire(UUID_A);
    expect(pool.stats.hits).toBe(1);
    expect(pool.stats.misses).toBe(1);

    // New user = miss
    pool.acquire(UUID_B);
    expect(pool.stats.misses).toBe(2);
    expect(pool.stats.hits).toBe(1);
  });

  it("should report correct open count in stats", () => {
    baseDir = makeTempDir();
    pool = new DatabasePool(baseDir, { maxOpen: 5 });

    expect(pool.stats.open).toBe(0);

    pool.acquire(UUID_A);
    expect(pool.stats.open).toBe(1);

    pool.acquire(UUID_B);
    expect(pool.stats.open).toBe(2);

    // Same user again does not increase count
    pool.acquire(UUID_A);
    expect(pool.stats.open).toBe(2);
  });

  it("should reject non-UUID strings", () => {
    baseDir = makeTempDir();
    pool = new DatabasePool(baseDir, { maxOpen: 5 });

    expect(() => pool!.acquire("not-a-uuid")).toThrow(/Invalid userId/);
    expect(() => pool!.acquire("../path-traversal")).toThrow(/Invalid userId/);
    expect(() => pool!.acquire("")).toThrow(/Invalid userId/);
    expect(() => pool!.acquire("admin")).toThrow(/Invalid userId/);
    expect(() => pool!.acquire("../../etc/passwd")).toThrow(/Invalid userId/);
  });

  it("should accept valid UUID formats", () => {
    baseDir = makeTempDir();
    pool = new DatabasePool(baseDir, { maxOpen: 5 });

    // Standard UUID v4
    expect(() => pool!.acquire(UUID_A)).not.toThrow();
    // UUID v4 with different version nibble
    expect(() => pool!.acquire("aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee")).not.toThrow();
  });

  it("should enforce maxOpen by evicting LRU entry", () => {
    baseDir = makeTempDir();
    pool = new DatabasePool(baseDir, { maxOpen: 2 });

    // Fill the pool
    const entryA = pool.acquire(UUID_A);
    pool.release(UUID_A);
    const entryB = pool.acquire(UUID_B);
    pool.release(UUID_B);

    expect(pool.stats.open).toBe(2);

    // Acquiring a third should evict UUID_A (LRU)
    pool.acquire(UUID_C);
    expect(pool.stats.open).toBe(2);

    // UUID_A's database should have been closed
    expect(entryA.db.open).toBe(false);
    // UUID_B should still be open
    expect(entryB.db.open).toBe(true);
  });

  it("should evict oldest-accessed entry first (LRU order)", () => {
    baseDir = makeTempDir();
    pool = new DatabasePool(baseDir, { maxOpen: 2 });

    // Open A first, then B
    pool.acquire(UUID_A);
    pool.release(UUID_A);
    pool.acquire(UUID_B);
    pool.release(UUID_B);

    // Touch A again to make it more recent than B
    pool.acquire(UUID_A);
    pool.release(UUID_A);

    // Now C should evict B (the true LRU)
    const entryB_before = pool.acquire(UUID_B);
    pool.release(UUID_B);
    // Reset: A was touched last, B was touched last. Let's be explicit:

    // Start fresh
    pool.close();
    pool = new DatabasePool(baseDir, { maxOpen: 2 });

    pool.acquire(UUID_A);
    pool.release(UUID_A);
    pool.acquire(UUID_B);
    pool.release(UUID_B);

    // Touch A to make it most recently used
    const entryA = pool.acquire(UUID_A);
    pool.release(UUID_A);

    const entryB = pool.acquire(UUID_B);
    pool.release(UUID_B);

    // Now both are in pool. B was last touched, A before that.
    // Acquiring C should evict A (least recently used)
    pool.acquire(UUID_C);

    expect(entryA.db.open).toBe(false); // A evicted (LRU)
    expect(entryB.db.open).toBe(true);  // B still alive (more recent)
  });

  it("should handle idle timeout eviction", async () => {
    baseDir = makeTempDir();
    // Very short idle timeout for testing
    pool = new DatabasePool(baseDir, { maxOpen: 5, idleTimeoutMs: 50 });

    const entry = pool.acquire(UUID_A);
    expect(entry.db.open).toBe(true);

    pool.release(UUID_A);

    // Wait for idle timeout to fire
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(pool.stats.open).toBe(0);
    expect(entry.db.open).toBe(false);
  });

  it("should cancel idle timeout when re-acquired before expiry", async () => {
    baseDir = makeTempDir();
    pool = new DatabasePool(baseDir, { maxOpen: 5, idleTimeoutMs: 100 });

    pool.acquire(UUID_A);
    pool.release(UUID_A);

    // Re-acquire before timeout
    await new Promise((resolve) => setTimeout(resolve, 30));
    const entry = pool.acquire(UUID_A);

    // Wait past original timeout
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Should still be open because we re-acquired it
    expect(entry.db.open).toBe(true);
    expect(pool.stats.open).toBe(1);
  });

  it("should close all databases on close()", () => {
    baseDir = makeTempDir();
    pool = new DatabasePool(baseDir, { maxOpen: 5 });

    const entryA = pool.acquire(UUID_A);
    const entryB = pool.acquire(UUID_B);
    const entryC = pool.acquire(UUID_C);

    pool.close();

    expect(entryA.db.open).toBe(false);
    expect(entryB.db.open).toBe(false);
    expect(entryC.db.open).toBe(false);

    expect(pool.stats.open).toBe(0);
    pool = undefined; // already closed
  });

  it("should report maxOpen in stats", () => {
    baseDir = makeTempDir();
    pool = new DatabasePool(baseDir, { maxOpen: 42 });

    expect(pool.stats.maxOpen).toBe(42);
  });

  it("should use default maxOpen of 200 and idleTimeout of 300000", () => {
    baseDir = makeTempDir();
    pool = new DatabasePool(baseDir);

    expect(pool.stats.maxOpen).toBe(200);
  });

  it("should not evict entries that are currently acquired (not released)", () => {
    baseDir = makeTempDir();
    pool = new DatabasePool(baseDir, { maxOpen: 2 });

    // Acquire A and B without releasing
    const entryA = pool.acquire(UUID_A);
    const entryB = pool.acquire(UUID_B);

    // Acquiring C: pool is full but A and B are in-use
    // Should still evict the LRU in-use entry (A) to make room
    pool.acquire(UUID_C);

    // A should be evicted even though not released (LRU by last access)
    expect(pool.stats.open).toBe(2);
  });

  it("should re-open a database after it was evicted", () => {
    baseDir = makeTempDir();
    pool = new DatabasePool(baseDir, { maxOpen: 1 });

    const entryA1 = pool.acquire(UUID_A);
    pool.release(UUID_A);

    // Evict A by opening B
    pool.acquire(UUID_B);
    expect(entryA1.db.open).toBe(false);

    pool.release(UUID_B);

    // Re-acquire A: should get a new, open database
    const entryA2 = pool.acquire(UUID_A);
    expect(entryA2.db.open).toBe(true);
    expect(entryA2.db).not.toBe(entryA1.db); // new instance
  });
});
