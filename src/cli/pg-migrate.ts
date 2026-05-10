/**
 * strata migrate pg — Postgres migration CLI command.
 *
 * Exposes the pg migration runner for explicit operations use:
 *
 *   strata migrate pg              Apply all pending migrations
 *   strata migrate pg --status     Show applied/pending without applying
 *   strata migrate pg --dry-run    Print what would be applied without running it
 *
 * Reads DATABASE_URL from the environment. Exits non-zero on error.
 *
 * This is the explicit-ops counterpart to the auto-migration that runs at
 * startup when createPgStorage() is called. Useful for:
 *   - Pre-deployment migration runs in CI/CD pipelines
 *   - Inspecting migration state on live deployments
 *   - Running with STRATA_NO_AUTO_MIGRATE=1 to take manual control
 *
 * Issue: kytheros/strata#10
 */

import { createPool } from "../storage/pg/pg-types.js";
import {
  runMigrations,
  getMigrationStatus,
  loadMigrationFiles,
} from "../storage/pg/pg-migrations.js";

export interface PgMigrateOptions {
  status?: boolean;
  dryRun?: boolean;
  log?: (msg: string) => void;
}

export async function pgMigrate(options: PgMigrateOptions = {}): Promise<void> {
  const log = options.log ?? console.log;
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.error(
      "[strata migrate pg] DATABASE_URL is not set.\n" +
      "Set DATABASE_URL to a Postgres connection string and retry.\n" +
      "Example: DATABASE_URL=postgresql://user:pass@host:5432/db strata migrate pg"
    );
    process.exit(1);
  }

  const pool = createPool({ connectionString });

  try {
    // ── --status: show state, no changes ──────────────────────────────
    if (options.status) {
      const status = await getMigrationStatus(pool);

      log(`\nPostgres migration status (${connectionString.replace(/:[^@]+@/, ":***@")})\n`);
      log(`  Applied:  ${status.applied}`);
      log(`  Pending:  ${status.pending}`);
      log("");

      for (const m of status.migrations) {
        const indicator = m.status === "applied" ? "[x]" : "[ ]";
        log(`  ${indicator} ${m.name}  (sha256: ${m.checksum.slice(0, 12)}...)`);
      }

      if (status.pending === 0) {
        log("\nSchema is up to date.");
      } else {
        log(`\n${status.pending} migration(s) pending. Run "strata migrate pg" to apply.`);
      }

      return;
    }

    // ── --dry-run: show what would run ────────────────────────────────
    if (options.dryRun) {
      const status = await getMigrationStatus(pool);
      const pending = status.migrations.filter((m) => m.status === "pending");

      if (pending.length === 0) {
        log("Dry run: no pending migrations. Schema is up to date.");
        return;
      }

      log(`\nDry run — would apply ${pending.length} migration(s):\n`);
      for (const m of pending) {
        log(`  ${m.name}  (sha256: ${m.checksum.slice(0, 12)}...)`);
      }
      log("");
      return;
    }

    // ── default: apply pending migrations ─────────────────────────────
    const statusBefore = await getMigrationStatus(pool);

    if (statusBefore.pending === 0) {
      log("Schema is up to date — no migrations to apply.");
      return;
    }

    log(`Applying ${statusBefore.pending} pending migration(s)...`);
    await runMigrations(pool);

    const statusAfter = await getMigrationStatus(pool);
    const applied = statusAfter.applied - statusBefore.applied;
    log(`\nDone. Applied ${applied} migration(s). Schema is now up to date.`);
  } finally {
    await pool.end();
  }
}

/**
 * Entry point when called as a CLI subcommand:
 *   strata migrate pg [--status] [--dry-run]
 */
export async function runPgMigrateCli(argv: string[]): Promise<void> {
  const status = argv.includes("--status");
  const dryRun = argv.includes("--dry-run");

  await pgMigrate({ status, dryRun }).catch((err) => {
    console.error(
      "[strata migrate pg] Error:",
      err instanceof Error ? err.message : String(err)
    );
    process.exit(1);
  });
}
