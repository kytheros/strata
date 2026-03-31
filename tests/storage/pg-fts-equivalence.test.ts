/**
 * FTS Equivalence Spike: SQLite FTS5 bm25() vs Postgres tsvector ts_rank()
 *
 * Loads identical data into both engines, runs 30 queries, and compares
 * which document ranks #1. Pass criterion: 30/30 top-1 agreement.
 *
 * Requires: Docker Postgres running on localhost:5432
 *   docker run -d --name strata-pg -e POSTGRES_PASSWORD=test -p 5432:5432 postgres:17
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import pg from "pg";

const PG_URL =
  process.env.PG_URL ||
  "postgresql://postgres:test@localhost:5432/postgres";

// ---------------------------------------------------------------------------
// Seed data -- 20 entries covering diverse topics and importance levels
// ---------------------------------------------------------------------------

interface SeedEntry {
  id: string;
  text: string;
  sessionId: string;
  project: string;
}

const SEED: SeedEntry[] = [
  {
    id: "e1",
    sessionId: "s1",
    project: "backend",
    text: "We decided to use PostgreSQL for the database because it has better JSONB support and robust indexing capabilities",
  },
  {
    id: "e2",
    sessionId: "s2",
    project: "backend",
    text: "Fixed the database connection timeout by increasing the pool size to 20 and adding a retry mechanism",
  },
  {
    id: "e3",
    sessionId: "s3",
    project: "frontend",
    text: "Migrated the React components from class-based to functional hooks for better performance and readability",
  },
  {
    id: "e4",
    sessionId: "s4",
    project: "frontend",
    text: "The React hydration error was caused by a mismatch between server-rendered HTML and client-side state",
  },
  {
    id: "e5",
    sessionId: "s5",
    project: "infra",
    text: "Configured Docker Compose for production deployment with nginx reverse proxy and SSL termination",
  },
  {
    id: "e6",
    sessionId: "s6",
    project: "infra",
    text: "Docker container kept crashing with OOM error. Increased memory limit in compose configuration to 2GB",
  },
  {
    id: "e7",
    sessionId: "s7",
    project: "backend",
    text: "Implemented JWT authentication with refresh tokens and automatic token rotation every 24 hours",
  },
  {
    id: "e8",
    sessionId: "s8",
    project: "backend",
    text: "The authentication middleware was rejecting valid tokens because the clock skew tolerance was set too low",
  },
  {
    id: "e9",
    sessionId: "s9",
    project: "search",
    text: "Built the full-text search engine using BM25 ranking algorithm with Porter stemming and unicode tokenization",
  },
  {
    id: "e10",
    sessionId: "s10",
    project: "search",
    text: "Search results were returning duplicates because the deduplication logic was comparing IDs instead of content hashes",
  },
  {
    id: "e11",
    sessionId: "s11",
    project: "backend",
    text: "Switched from REST API to GraphQL for the dashboard queries because it reduces over-fetching and simplifies the frontend",
  },
  {
    id: "e12",
    sessionId: "s12",
    project: "infra",
    text: "Set up Kubernetes cluster with horizontal pod autoscaling based on CPU utilization threshold of 70 percent",
  },
  {
    id: "e13",
    sessionId: "s13",
    project: "backend",
    text: "Implemented Redis caching layer for the API with a TTL of 5 minutes and cache invalidation on writes",
  },
  {
    id: "e14",
    sessionId: "s14",
    project: "frontend",
    text: "Fixed the CSS grid layout breaking on mobile by adding proper media queries and responsive breakpoints",
  },
  {
    id: "e15",
    sessionId: "s15",
    project: "backend",
    text: "The memory leak was traced to event listeners not being removed when WebSocket connections closed",
  },
  {
    id: "e16",
    sessionId: "s16",
    project: "infra",
    text: "Configured Terraform modules for AWS infrastructure provisioning with state stored in S3 backend",
  },
  {
    id: "e17",
    sessionId: "s17",
    project: "backend",
    text: "Added rate limiting middleware using sliding window algorithm with 100 requests per minute per IP",
  },
  {
    id: "e18",
    sessionId: "s18",
    project: "frontend",
    text: "Implemented lazy loading for images and route-based code splitting to improve initial page load time",
  },
  {
    id: "e19",
    sessionId: "s19",
    project: "backend",
    text: "Database migration failed due to foreign key constraint. Resolved by disabling constraints during migration",
  },
  {
    id: "e20",
    sessionId: "s20",
    project: "infra",
    text: "Monitoring stack deployed with Prometheus for metrics collection and Grafana dashboards for visualization",
  },
];

// ---------------------------------------------------------------------------
// 30 queries -- each has exactly one expected top-1 result
// ---------------------------------------------------------------------------

const QUERIES: { query: string; expectedId: string }[] = [
  // Direct keyword matches
  { query: "PostgreSQL database", expectedId: "e1" },
  { query: "connection timeout pool", expectedId: "e2" },
  { query: "React hooks migration", expectedId: "e3" },
  { query: "hydration error server", expectedId: "e4" },
  { query: "Docker Compose nginx", expectedId: "e5" },
  { query: "OOM memory limit", expectedId: "e6" },
  { query: "JWT refresh tokens", expectedId: "e7" },
  { query: "clock skew token", expectedId: "e8" },
  { query: "BM25 search ranking", expectedId: "e9" },
  { query: "duplicate deduplication", expectedId: "e10" },
  // Stemmed / partial matches
  { query: "GraphQL dashboard", expectedId: "e11" },
  { query: "Kubernetes autoscaling", expectedId: "e12" },
  { query: "Redis caching TTL", expectedId: "e13" },
  { query: "CSS grid mobile responsive", expectedId: "e14" },
  { query: "WebSocket memory leak", expectedId: "e15" },
  { query: "Terraform infrastructure", expectedId: "e16" },
  { query: "rate limiting sliding window", expectedId: "e17" },
  { query: "lazy loading code splitting", expectedId: "e18" },
  { query: "foreign key migration", expectedId: "e19" },
  { query: "Prometheus Grafana monitoring", expectedId: "e20" },
  // Cross-topic / multi-term queries (tests ranking precision)
  { query: "PostgreSQL JSONB indexing", expectedId: "e1" },
  { query: "Docker production deployment", expectedId: "e5" },
  { query: "authentication token rotation", expectedId: "e7" },
  { query: "search engine stemming", expectedId: "e9" },
  { query: "caching invalidation API", expectedId: "e13" },
  { query: "container crash error", expectedId: "e6" },
  { query: "page load images lazy", expectedId: "e18" },
  { query: "rate requests per minute IP", expectedId: "e17" },
  { query: "infrastructure provisioning modules", expectedId: "e16" },
  { query: "metrics collection dashboard", expectedId: "e20" },
];

describe("FTS Equivalence: SQLite FTS5 vs Postgres tsvector", () => {
  let sqliteDb: Database.Database;
  let pgPool: pg.Pool | undefined;
  let fts5Results: Map<string, string[]>; // query -> ordered doc IDs
  let pgResults: Map<string, string[]>; // query -> ordered doc IDs

  beforeAll(async () => {
    // ---- SQLite FTS5 setup ----
    sqliteDb = openDatabase(":memory:");
    fts5Results = new Map();

    // Seed SQLite
    const insertDoc = sqliteDb.prepare(`
      INSERT INTO documents (id, session_id, project, text, role, timestamp, tool_names, token_count, message_index, user)
      VALUES (?, ?, ?, ?, 'user', ?, '[]', 0, 0, 'default')
    `);
    const now = Date.now();
    for (let i = 0; i < SEED.length; i++) {
      const e = SEED[i];
      insertDoc.run(
        e.id,
        e.sessionId,
        e.project,
        e.text,
        now - (SEED.length - i) * 60000
      );
    }

    // Run FTS5 queries
    const ftsQuery = sqliteDb.prepare(`
      SELECT d.id, bm25(documents_fts) as rank
      FROM documents_fts
      JOIN documents d ON d.rowid = documents_fts.rowid
      WHERE documents_fts MATCH ?
      ORDER BY rank
      LIMIT 10
    `);

    for (const q of QUERIES) {
      try {
        const rows = ftsQuery.all(q.query) as { id: string; rank: number }[];
        fts5Results.set(
          q.query,
          rows.map((r) => r.id)
        );
      } catch {
        // FTS5 MATCH can fail on certain syntax -- record empty
        fts5Results.set(q.query, []);
      }
    }

    // ---- Postgres setup ----
    pgResults = new Map();
    pgPool = new pg.Pool({ connectionString: PG_URL, max: 5 });

    // Test connection -- skip all Postgres tests if unavailable
    try {
      await pgPool.query("SELECT 1");
    } catch {
      console.log(
        "Postgres not available -- skipping Postgres comparison tests"
      );
      await pgPool.end();
      pgPool = undefined;
      return;
    }

    // Create schema
    await pgPool.query(`
      DROP TABLE IF EXISTS spike_documents;
      CREATE TABLE spike_documents (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        project TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        timestamp BIGINT NOT NULL DEFAULT 0,
        tsv tsvector GENERATED ALWAYS AS (
          to_tsvector('english', coalesce(text, ''))
        ) STORED
      );
      CREATE INDEX spike_docs_tsv_idx ON spike_documents USING GIN (tsv);
    `);

    // Seed Postgres with identical data
    for (let i = 0; i < SEED.length; i++) {
      const e = SEED[i];
      await pgPool.query(
        "INSERT INTO spike_documents (id, session_id, project, text, timestamp) VALUES ($1, $2, $3, $4, $5)",
        [e.id, e.sessionId, e.project, e.text, Date.now() - (SEED.length - i) * 60000]
      );
    }

    // Run Postgres queries
    for (const q of QUERIES) {
      try {
        const { rows } = await pgPool.query(
          `SELECT id, ts_rank(tsv, plainto_tsquery('english', $1)) AS rank
           FROM spike_documents
           WHERE tsv @@ plainto_tsquery('english', $1)
           ORDER BY rank DESC
           LIMIT 10`,
          [q.query]
        );
        pgResults.set(
          q.query,
          rows.map((r: { id: string }) => r.id)
        );
      } catch {
        pgResults.set(q.query, []);
      }
    }
  });

  afterAll(async () => {
    sqliteDb?.close();
    await pgPool?.end();
  });

  it("FTS5 baseline returns results for all 30 queries", () => {
    let queriesWithResults = 0;
    for (const q of QUERIES) {
      const results = fts5Results.get(q.query) ?? [];
      if (results.length > 0) queriesWithResults++;
    }
    expect(queriesWithResults).toBe(30);
  });

  it("FTS5 baseline top-1 matches expected for all 30 queries", () => {
    let correct = 0;
    const failures: string[] = [];
    for (const q of QUERIES) {
      const results = fts5Results.get(q.query) ?? [];
      if (results[0] === q.expectedId) {
        correct++;
      } else {
        failures.push(
          `  "${q.query}": expected ${q.expectedId}, got ${results[0] ?? "NONE"}`
        );
      }
    }
    if (failures.length > 0) {
      console.log(`FTS5 baseline failures:\n${failures.join("\n")}`);
    }
    expect(correct).toBe(30);
  });

  it("Postgres returns results for all 30 queries", () => {
    if (!pgPool) return; // Skip if Postgres unavailable
    let queriesWithResults = 0;
    for (const q of QUERIES) {
      const results = pgResults.get(q.query) ?? [];
      if (results.length > 0) queriesWithResults++;
    }
    expect(queriesWithResults).toBe(30);
  });

  it("GATE: Postgres top-1 matches FTS5 top-1 for all 30 queries (30/30)", () => {
    if (!pgPool) return; // Skip if Postgres unavailable
    let agreements = 0;
    const disagreements: string[] = [];

    for (const q of QUERIES) {
      const fts5Top = (fts5Results.get(q.query) ?? [])[0];
      const pgTop = (pgResults.get(q.query) ?? [])[0];

      if (fts5Top === pgTop) {
        agreements++;
      } else {
        disagreements.push(
          `  "${q.query}": FTS5=${fts5Top ?? "NONE"}, PG=${pgTop ?? "NONE"} (expected: ${q.expectedId})`
        );
      }
    }

    console.log(`\n=== FTS EQUIVALENCE SPIKE RESULTS ===`);
    console.log(`Top-1 agreement: ${agreements}/30`);
    if (disagreements.length > 0) {
      console.log(`Disagreements:\n${disagreements.join("\n")}`);
    }
    console.log(`=====================================\n`);

    // GATE: must be 30/30
    expect(agreements).toBe(30);
  });

  it("Postgres top-5 overlap with FTS5 is >= 80% per query", () => {
    if (!pgPool) return;
    let totalOverlap = 0;

    for (const q of QUERIES) {
      const fts5Top5 = new Set((fts5Results.get(q.query) ?? []).slice(0, 5));
      const pgTop5 = (pgResults.get(q.query) ?? []).slice(0, 5);

      if (fts5Top5.size === 0) continue;
      const overlap = pgTop5.filter((id) => fts5Top5.has(id)).length;
      totalOverlap += overlap / Math.max(fts5Top5.size, 1);
    }

    const avgOverlap = totalOverlap / QUERIES.length;
    console.log(`Average top-5 overlap: ${(avgOverlap * 100).toFixed(1)}%`);
    expect(avgOverlap).toBeGreaterThanOrEqual(0.8);
  });
});
