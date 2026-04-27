/**
 * Test: Postgres schema applies cleanly.
 *
 * Requires Docker Postgres running on localhost:5432:
 *   docker run -d --name strata-pg -e POSTGRES_PASSWORD=test -p 5432:5432 postgres:17
 *
 * Run: PG_URL="postgresql://postgres:test@localhost:5432/postgres" npx vitest run tests/storage/pg-schema.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { createSchema, PG_SCHEMA_VERSION } from "../../src/storage/pg/schema.js";

const PG_URL = process.env.PG_URL || "postgresql://postgres:test@localhost:5432/postgres";

describe("Postgres Schema", () => {
  let pool: pg.Pool | undefined;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL, max: 3 });
    try {
      await pool.query("SELECT 1");
    } catch {
      console.log("Postgres not available -- skipping pg-schema tests");
      await pool.end();
      pool = undefined;
    }
    if (pool) {
      // Ensure schema exists for subsequent tests
      await createSchema(pool);
    }
  });

  afterAll(async () => {
    if (pool) {
      // Don't drop schema here -- other test files may be running in parallel
      // Clean up test data only
      await pool.query("DELETE FROM documents WHERE id = 'test-tsv-1'").catch(() => {});
      await pool.end();
    }
  });

  it("should have all required tables", async () => {
    if (!pool) return;

    // Verify tables exist
    const { rows } = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    );

    const tableNames = rows.map((r) => r.tablename);
    expect(tableNames).toContain("documents");
    expect(tableNames).toContain("knowledge");
    expect(tableNames).toContain("knowledge_history");
    expect(tableNames).toContain("summaries");
    expect(tableNames).toContain("index_meta");
    expect(tableNames).toContain("embeddings");
    expect(tableNames).toContain("entities");
    expect(tableNames).toContain("entity_relations");
    expect(tableNames).toContain("knowledge_entities");
    expect(tableNames).toContain("events");
    expect(tableNames).toContain("evidence_gaps");
    expect(tableNames).toContain("analytics");
    expect(tableNames).toContain("migration_state");
    expect(tableNames).toContain("stored_documents");
    expect(tableNames).toContain("document_chunks");
    expect(tableNames).toContain("training_data");
  });

  it("should record schema version in index_meta", async () => {
    if (!pool) return;

    const { rows } = await pool.query<{ value: string }>(
      "SELECT value FROM index_meta WHERE key = 'schema_version'"
    );
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe(PG_SCHEMA_VERSION);
  });

  it("should be idempotent (re-apply without error)", async () => {
    if (!pool) return;

    // Apply again -- should not throw
    await createSchema(pool);

    // Schema version should still be correct
    const { rows } = await pool.query<{ value: string }>(
      "SELECT value FROM index_meta WHERE key = 'schema_version'"
    );
    expect(rows[0].value).toBe(PG_SCHEMA_VERSION);
  });

  it("should have tsvector columns on documents, knowledge, events, document_chunks", async () => {
    if (!pool) return;

    const tablesWithTsv = ["documents", "knowledge", "events", "document_chunks"];

    for (const table of tablesWithTsv) {
      const { rows } = await pool.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_name = $1 AND column_name = 'tsv'`,
        [table]
      );
      expect(rows.length, `${table} should have a tsv column`).toBe(1);
      expect(rows[0].data_type).toBe("tsvector");
    }
  });

  it("should have GIN indexes on tsvector columns", async () => {
    if (!pool) return;

    const expectedIndexes = [
      "idx_documents_tsv",
      "idx_knowledge_tsv",
      "idx_events_tsv",
      "idx_document_chunks_tsv",
    ];

    for (const indexName of expectedIndexes) {
      const { rows } = await pool.query(
        "SELECT 1 FROM pg_indexes WHERE indexname = $1",
        [indexName]
      );
      expect(rows.length, `Index ${indexName} should exist`).toBe(1);
    }
  });

  it("should auto-generate tsvector on insert", async () => {
    if (!pool) return;

    // Insert a test document
    await pool.query(
      `INSERT INTO documents (id, session_id, project, text, role, timestamp, token_count, message_index, user_scope)
       VALUES ('test-tsv-1', 'session-1', 'test', 'PostgreSQL full-text search with tsvector', 'user', $1, 5, 0, 'default')`,
      [Date.now()]
    );

    // Check that tsv column was populated
    const { rows } = await pool.query<{ tsv: string }>(
      "SELECT tsv::text FROM documents WHERE id = 'test-tsv-1'"
    );

    expect(rows.length).toBe(1);
    expect(rows[0].tsv).toContain("postgresql");
    expect(rows[0].tsv).toContain("full-text");

    // Clean up
    await pool.query("DELETE FROM documents WHERE id = 'test-tsv-1'");
  });
});
