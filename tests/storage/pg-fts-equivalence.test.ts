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
  { query: "database configuration", expectedId: "e1" },
  { query: "Docker production deployment", expectedId: "e5" },
  { query: "authentication token rotation", expectedId: "e7" },
  { query: "search engine full-text", expectedId: "e9" },
  { query: "caching invalidation API", expectedId: "e13" },
  { query: "container crash error", expectedId: "e6" },
  { query: "frontend performance optimization", expectedId: "e18" },
  { query: "API middleware request limit", expectedId: "e17" },
  { query: "infrastructure provisioning modules", expectedId: "e16" },
  { query: "metrics collection dashboard", expectedId: "e20" },
];

describe("FTS Equivalence: SQLite FTS5 vs Postgres tsvector", () => {
  // Tests added in Task 3
});
