# Strata Postgres Migrations

This directory contains the managed migration files for the Strata Postgres backend.

## File naming convention

```
NNNN_description.sql
```

- `NNNN` — 4-digit zero-padded version number, e.g. `0001`, `0004`, `0042`.
- `description` — short snake_case description of what the migration does.

Examples:
- `0001_baseline.sql` — Initial schema (all baseline tables)
- `0004_knowledge_turns.sql` — Add knowledge_turns table for TIR+QDP

## Forward-only policy

**There are no down migrations.** This is a deliberate design decision:

- Rollbacks are risky: they can silently discard data written by the newer schema.
- For Strata, the correct rollback path is to restore from a database backup taken
  before the migration ran — not to run a destructive DDL reversal.
- If a migration contains an error, write a new `00NN_fix_something.sql` that
  corrects the issue additively.

## How migrations are applied

The migration runner (`src/storage/pg/pg-migrations.ts`) runs automatically at
server startup when `createPgStorage()` is called:

1. Ensures the `schema_migrations` tracking table exists.
2. Reads all `.sql` files from this directory, sorted lexicographically (= numeric order).
3. Verifies checksums of already-applied migrations against on-disk content.
   A mismatch aborts startup with a diagnostic pointing at `STRATA_ALLOW_DRIFT=1`.
4. Applies each pending migration in a transaction.
5. Records the migration version, filename, and sha256 checksum.

## Environment variables

| Variable | Effect |
|----------|--------|
| `STRATA_NO_AUTO_MIGRATE=1` | Skip auto-migration at startup. Use `strata migrate pg` to apply explicitly. |
| `STRATA_ALLOW_DRIFT=1` | Bypass checksum mismatch errors. Operators only — use when manual DDL changes were made and you accept the drift. |

## Adding a new migration

1. Create `NNNN_description.sql` with the next sequential version number.
2. Write `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` DDL only.
   - All migrations are DDL-only (no DML). Data backfills are opt-in CLI commands.
   - Use `IF NOT EXISTS` so migrations are safe to re-apply (idempotent DDL).
   - Never `ALTER TABLE` an existing tracked table — add new columns only if
     PostgreSQL allows it without rewriting the table. For breaking changes,
     add a new table instead (D1 constraint from the Strata architecture guide).
3. Test locally: `DATABASE_URL=... strata migrate pg --dry-run` then `strata migrate pg`.
4. Commit the `.sql` file. **Never edit a migration file after it has been applied
   to any environment** — the checksum stored in `schema_migrations` will mismatch
   and abort startup.

## Tracking table schema

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT        PRIMARY KEY,  -- e.g. "0001"
  name       TEXT        NOT NULL,     -- e.g. "0001_baseline.sql"
  checksum   TEXT        NOT NULL,     -- sha256 hex of file content
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```
