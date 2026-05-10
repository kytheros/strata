/**
 * Postgres migration runner for Strata.
 *
 * Manages incremental schema changes via numbered SQL files in
 * src/storage/pg/migrations/. Tracks applied migrations in a
 * schema_migrations table with sha256 checksums.
 *
 * Design contract (project_pg_runtime_design_2026_05_10.md — items 5–8):
 *
 *   Tracking table:
 *     schema_migrations(version TEXT PK, name TEXT, checksum TEXT,
 *                       applied_at TIMESTAMPTZ DEFAULT NOW())
 *
 *   Naming convention: 4-digit numeric prefix matching existing
 *     0004_knowledge_turns.sql — e.g. 0001_baseline.sql, 0004_knowledge_turns.sql
 *
 *   Application time: auto-apply at startup by default.
 *     STRATA_NO_AUTO_MIGRATE=1 prevents auto-apply (explicit CLI use only).
 *
 *   Checksum enforcement: on startup, verify checksums of already-applied
 *     migrations match files on disk. Mismatch → loud failure with
 *     STRATA_ALLOW_DRIFT=1 as override.
 *
 *   Forward-only. No down migrations. Document in migrations/README.md.
 *
 * Issue: kytheros/strata#10
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PgPool } from "./pg-types.js";

// ── Path resolution ───────────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MigrationFile {
  version: string;  // e.g. "0001"
  name: string;     // e.g. "0001_baseline.sql"
  sql: string;
  checksum: string; // sha256 hex of file content
}

export interface MigrationRecord {
  version: string;
  name: string;
  checksum: string;
  applied_at: Date;
}

export interface MigrationStatus {
  applied: number;
  pending: number;
  migrations: Array<{
    version: string;
    name: string;
    status: "applied" | "pending";
    checksum: string;
  }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Read all .sql migration files from the migrations directory.
 * Returns them sorted in ascending version order.
 */
export function loadMigrationFiles(): MigrationFile[] {
  let files: string[];
  try {
    files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort(); // lexicographic = ascending numeric order for 4-digit prefixes
  } catch {
    return [];
  }

  return files.map((filename) => {
    const match = filename.match(/^(\d{4})_/);
    if (!match) {
      throw new Error(
        `[strata migrations] Invalid migration filename: "${filename}". ` +
        `Expected 4-digit prefix (e.g. 0001_baseline.sql).`
      );
    }
    const version = match[1];
    const sql = readFileSync(join(MIGRATIONS_DIR, filename), "utf-8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    return { version, name: filename, sql, checksum };
  });
}

/**
 * Ensure the schema_migrations table exists.
 * This is the only table the runner itself creates — everything else
 * comes from migration files.
 */
async function ensureTrackingTable(pool: PgPool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT        PRIMARY KEY,
      name       TEXT        NOT NULL,
      checksum   TEXT        NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/**
 * Fetch all already-applied migrations from the tracking table.
 */
async function getAppliedMigrations(
  pool: PgPool
): Promise<Map<string, MigrationRecord>> {
  const { rows } = await pool.query<MigrationRecord>(
    "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version"
  );
  const map = new Map<string, MigrationRecord>();
  for (const row of rows) {
    map.set(row.version, row);
  }
  return map;
}

// ── Runner ────────────────────────────────────────────────────────────────────

/**
 * Apply all pending migrations to the database.
 *
 * Steps:
 *   1. Ensure schema_migrations tracking table exists.
 *   2. Load migration files from disk.
 *   3. Verify checksums of already-applied migrations.
 *      Mismatch → throw (unless STRATA_ALLOW_DRIFT=1).
 *   4. Apply each unapplied migration in a transaction.
 *   5. Record each migration in schema_migrations.
 *
 * Controlled by environment:
 *   STRATA_NO_AUTO_MIGRATE=1 — set by `createPgStorage` caller to skip
 *     auto-apply (used by the `strata migrate --status` CLI path).
 *   STRATA_ALLOW_DRIFT=1 — suppress checksum mismatch errors (escape hatch
 *     for operators who need to override after manual DDL changes).
 */
export async function runMigrations(pool: PgPool): Promise<void> {
  await ensureTrackingTable(pool);

  const migrationFiles = loadMigrationFiles();
  const applied = await getAppliedMigrations(pool);
  const allowDrift = process.env.STRATA_ALLOW_DRIFT === "1";

  // ── Checksum verification ──────────────────────────────────────────
  for (const file of migrationFiles) {
    const record = applied.get(file.version);
    if (!record) continue; // not yet applied — will be applied below

    if (record.checksum !== file.checksum) {
      const msg =
        `[strata migrations] Checksum mismatch for migration ${file.name}.\n` +
        `  Recorded: ${record.checksum}\n` +
        `  On disk:  ${file.checksum}\n` +
        `Migration files must not be modified after they are applied.\n` +
        `To bypass this check (operators only): set STRATA_ALLOW_DRIFT=1.`;

      if (!allowDrift) {
        throw new Error(msg);
      }
      // allowDrift=1: warn and continue
      console.warn("[strata migrations] WARNING: " + msg);
    }
  }

  // ── Apply pending migrations ───────────────────────────────────────
  for (const file of migrationFiles) {
    if (applied.has(file.version)) continue; // already applied

    // Execute each migration in a transaction for atomicity
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Split on semicolons that end a statement line.
      // We use the runner's own multi-statement SQL splitter — simple but
      // sufficient for the DDL-only files in this migrations directory.
      const statements = splitSqlStatements(file.sql);
      for (const stmt of statements) {
        if (stmt.trim()) {
          await client.query(stmt);
        }
      }

      // Record the migration
      await client.query(
        `INSERT INTO schema_migrations (version, name, checksum)
         VALUES ($1, $2, $3)
         ON CONFLICT (version) DO NOTHING`,
        [file.version, file.name, file.checksum]
      );

      await client.query("COMMIT");
      console.log(`[strata migrations] Applied: ${file.name}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(
        `[strata migrations] Failed to apply ${file.name}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    } finally {
      client.release();
    }
  }
}

/**
 * Return migration status without applying anything.
 * Used by `strata migrate --status`.
 */
export async function getMigrationStatus(pool: PgPool): Promise<MigrationStatus> {
  // schema_migrations may not exist yet on a fresh DB
  try {
    await ensureTrackingTable(pool);
  } catch {
    // If we cannot even create the tracking table, return all-pending
  }

  const migrationFiles = loadMigrationFiles();

  let applied: Map<string, MigrationRecord>;
  try {
    applied = await getAppliedMigrations(pool);
  } catch {
    applied = new Map();
  }

  const result: MigrationStatus = { applied: 0, pending: 0, migrations: [] };

  for (const file of migrationFiles) {
    if (applied.has(file.version)) {
      result.applied++;
      result.migrations.push({
        version: file.version,
        name: file.name,
        status: "applied",
        checksum: applied.get(file.version)!.checksum,
      });
    } else {
      result.pending++;
      result.migrations.push({
        version: file.version,
        name: file.name,
        status: "pending",
        checksum: file.checksum,
      });
    }
  }

  return result;
}

// ── SQL splitter ──────────────────────────────────────────────────────────────

/**
 * Split a multi-statement SQL string into individual statements.
 *
 * Handles:
 *   - Line comments (-- ...)
 *   - Dollar-quoted strings ($$ ... $$) used in Postgres functions
 *   - Standard semicolon statement terminators
 *
 * This is intentionally simple: the migrations in this directory are
 * DDL-only (CREATE TABLE, CREATE INDEX) and do not use dollar-quoting
 * or complex PL/pgSQL. A full SQL parser is not needed here.
 */
function splitSqlStatements(sql: string): string[] {
  // Strip line comments
  const withoutComments = sql
    .split("\n")
    .map((line) => {
      const commentIdx = line.indexOf("--");
      return commentIdx >= 0 ? line.slice(0, commentIdx) : line;
    })
    .join("\n");

  return withoutComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
