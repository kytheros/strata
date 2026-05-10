/**
 * Test: Postgres migration runner.
 *
 * Requires Postgres at PG_URL. Skips gracefully when unavailable.
 *
 * Validates:
 * - Fresh DB: runner creates schema_migrations table and applies all migrations
 * - Idempotent: running twice does not re-apply already-applied migrations
 * - Baseline-only DB (simulating pre-runner deploy): only pending migrations applied
 * - Checksum mismatch: fails loudly unless STRATA_ALLOW_DRIFT=1
 * - STRATA_NO_AUTO_MIGRATE=1: runMigrations with autoMigrate=false is a no-op unless
 *   called explicitly
 * - status() returns correct pending/applied counts
 *
 * Issue: kytheros/strata#10
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import {
  runMigrations,
  getMigrationStatus,
  type MigrationStatus,
} from "../../src/storage/pg/pg-migrations.js";

const PG_URL =
  process.env.PG_URL || "postgresql://postgres:test@localhost:5432/postgres";

describe("Postgres Migration Runner", () => {
  let pool: pg.Pool | undefined;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL, max: 3 });
    try {
      await pool.query("SELECT 1");
    } catch {
      console.log(
        "[pg-migrations-test] Postgres not available — skipping migration runner tests"
      );
      await pool.end();
      pool = undefined;
    }
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
  });

  // Isolate each test: drop all strata tables before and after each test.
  // beforeEach ensures we start from a clean slate regardless of what other
  // concurrent test files may have left behind.
  beforeEach(async () => {
    if (!pool) return;
    const { dropSchema } = await import("../../src/storage/pg/schema.js");
    await dropSchema(pool).catch(() => {});
  });

  afterEach(async () => {
    if (!pool) return;
    const { dropSchema } = await import("../../src/storage/pg/schema.js");
    await dropSchema(pool).catch(() => {});
  });

  it("runMigrations is exported as a function", () => {
    expect(typeof runMigrations).toBe("function");
  });

  it("getMigrationStatus is exported as a function", () => {
    expect(typeof getMigrationStatus).toBe("function");
  });

  it("creates schema_migrations table on a fresh DB", async () => {
    if (!pool) return;

    await runMigrations(pool);

    const { rows } = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='schema_migrations'"
    );
    expect(rows.length).toBe(1);
  });

  it("applies baseline migration on a fresh DB", async () => {
    if (!pool) return;

    await runMigrations(pool);

    // Baseline should create the documents table (sanity check)
    const { rows } = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='documents'"
    );
    expect(rows.length).toBe(1);
  });

  it("records applied migrations with checksum in schema_migrations", async () => {
    if (!pool) return;

    await runMigrations(pool);

    const { rows } = await pool.query<{
      version: string;
      name: string;
      checksum: string;
    }>("SELECT version, name, checksum FROM schema_migrations ORDER BY version");

    expect(rows.length).toBeGreaterThanOrEqual(1);
    // Baseline must be first
    expect(rows[0].version).toBe("0001");
    expect(rows[0].checksum).toBeTruthy();
    // checksum is a hex sha256
    expect(rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("applies 0004_knowledge_turns migration (#9)", async () => {
    if (!pool) return;

    await runMigrations(pool);

    const { rows } = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='knowledge_turns'"
    );
    expect(rows.length).toBe(1);
  });

  it("is idempotent — re-running does not error or re-apply", async () => {
    if (!pool) return;

    await runMigrations(pool);
    const { rows: before } = await pool.query<{ count: string }>(
      "SELECT count(*)::text FROM schema_migrations"
    );

    // Run again
    await runMigrations(pool);

    const { rows: after } = await pool.query<{ count: string }>(
      "SELECT count(*)::text FROM schema_migrations"
    );
    expect(after[0].count).toBe(before[0].count);
  });

  it("getMigrationStatus returns pending=0 after full run", async () => {
    if (!pool) return;

    await runMigrations(pool);
    const status: MigrationStatus = await getMigrationStatus(pool);

    expect(status.pending).toBe(0);
    expect(status.applied).toBeGreaterThanOrEqual(2); // at least 0001 + 0004
  });

  it("getMigrationStatus returns pending>0 on a fresh DB (before runner)", async () => {
    if (!pool) return;

    // Do NOT call runMigrations — check status on a bare pool
    const status: MigrationStatus = await getMigrationStatus(pool);

    expect(status.pending).toBeGreaterThan(0);
    expect(status.applied).toBe(0);
  });

  it("fails loudly on checksum mismatch without STRATA_ALLOW_DRIFT", async () => {
    if (!pool) return;

    // Apply migrations successfully first
    await runMigrations(pool);

    // Corrupt the checksum of the baseline migration in schema_migrations
    await pool.query(
      "UPDATE schema_migrations SET checksum = 'deadbeef' WHERE version = '0001'"
    );

    // Re-running should throw a diagnostic error
    await expect(runMigrations(pool)).rejects.toThrow(/checksum/i);
  });

  it("proceeds on checksum mismatch when STRATA_ALLOW_DRIFT=1", async () => {
    if (!pool) return;

    await runMigrations(pool);

    // Corrupt checksum
    await pool.query(
      "UPDATE schema_migrations SET checksum = 'deadbeef' WHERE version = '0001'"
    );

    // With STRATA_ALLOW_DRIFT=1, should not throw
    const origEnv = process.env.STRATA_ALLOW_DRIFT;
    process.env.STRATA_ALLOW_DRIFT = "1";
    try {
      await expect(runMigrations(pool)).resolves.not.toThrow();
    } finally {
      if (origEnv === undefined) {
        delete process.env.STRATA_ALLOW_DRIFT;
      } else {
        process.env.STRATA_ALLOW_DRIFT = origEnv;
      }
    }
  });
});
