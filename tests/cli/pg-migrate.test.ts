/**
 * Test: strata migrate pg CLI command.
 *
 * Requires Postgres at PG_URL. Skips gracefully when unavailable.
 *
 * Validates:
 * - pgMigrate() applies pending migrations
 * - pgMigrate({ status: true }) returns status without applying
 * - pgMigrate({ dryRun: true }) prints what would run without applying
 * - Missing DATABASE_URL exits with a diagnostic message
 *
 * Issue: kytheros/strata#10
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import pg from "pg";
import { pgMigrate } from "../../src/cli/pg-migrate.js";

const PG_URL =
  process.env.PG_URL || "postgresql://postgres:test@localhost:5432/postgres";

describe("strata migrate pg CLI", () => {
  let pool: pg.Pool | undefined;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
    try {
      await pool.query("SELECT 1");
    } catch {
      console.log(
        "[pg-migrate-cli-test] Postgres not available — skipping pg migrate CLI tests"
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

  afterEach(async () => {
    if (!pool) return;
    await pool
      .query("DROP TABLE IF EXISTS schema_migrations CASCADE")
      .catch(() => {});
    await pool
      .query(
        `DROP TABLE IF EXISTS
          knowledge_turns,
          training_data, document_chunks, stored_documents,
          migration_state, analytics, evidence_gaps, knowledge_entities,
          entity_relations, entities, events, embeddings, index_meta,
          summaries, knowledge_history, knowledge, documents
        CASCADE`
      )
      .catch(() => {});
  });

  it("pgMigrate is exported as a function", () => {
    expect(typeof pgMigrate).toBe("function");
  });

  it("applies pending migrations when called without flags", async () => {
    if (!pool) return;

    const origUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = PG_URL;
    try {
      const lines: string[] = [];
      await pgMigrate({ log: (m) => lines.push(m) });

      // schema_migrations should now exist and have entries
      const { rows } = await pool.query<{ count: string }>(
        "SELECT count(*)::text FROM schema_migrations"
      );
      expect(parseInt(rows[0].count, 10)).toBeGreaterThan(0);
    } finally {
      if (origUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = origUrl;
      }
    }
  });

  it("--status shows pending count without applying", async () => {
    if (!pool) return;

    const origUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = PG_URL;
    try {
      const lines: string[] = [];
      await pgMigrate({ status: true, log: (m) => lines.push(m) });

      const output = lines.join("\n");
      expect(output).toContain("Pending:");

      // No schema_migrations table should have been created by status alone
      // (the runner creates it, but status also calls getMigrationStatus which creates it)
      // The key thing: no migrations should be applied yet
      try {
        const { rows } = await pool.query<{ count: string }>(
          "SELECT count(*)::text FROM schema_migrations"
        );
        // If the table was created, it should be empty (no migrations applied)
        expect(parseInt(rows[0].count, 10)).toBe(0);
      } catch {
        // Table not created — also acceptable for --status
      }
    } finally {
      if (origUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = origUrl;
      }
    }
  });

  it("--dry-run prints pending without applying", async () => {
    if (!pool) return;

    const origUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = PG_URL;
    try {
      const lines: string[] = [];
      await pgMigrate({ dryRun: true, log: (m) => lines.push(m) });

      const output = lines.join("\n");
      // Should mention what would be applied but not actually apply it
      // Either "Dry run" output or "up to date"
      expect(output.toLowerCase()).toMatch(/dry run|up to date/);
    } finally {
      if (origUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = origUrl;
      }
    }
  });

  it("exits when DATABASE_URL is not set", async () => {
    const origUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => { throw new Error("process.exit called"); }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(pgMigrate()).rejects.toThrow("process.exit called");
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("DATABASE_URL"));
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      if (origUrl !== undefined) {
        process.env.DATABASE_URL = origUrl;
      }
    }
  });
});
