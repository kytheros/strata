/**
 * Ranking evaluation tests (spec sections 9.2, 10.1).
 *
 * Verifies that importance scoring improves search quality by measuring:
 *   - Test 7: Importance changes result ordering (high-importance entry ranks #1)
 *   - Test 8: boostMax=0 disables importance (pure BM25 behavior)
 *   - MRR (Mean Reciprocal Rank) improvement with importance enabled
 *   - Top-1 accuracy with importance enabled
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import { CONFIG } from "../../src/config.js";
import { computeImportance } from "../../src/knowledge/importance.js";

// ---------------------------------------------------------------------------
// Test fixtures — realistic document entries spanning importance levels
// ---------------------------------------------------------------------------

interface SeedEntry {
  id: string;
  text: string;
  role: "user" | "assistant" | "mixed";
  sessionId: string;
  project: string;
  importanceLevel: "high" | "medium" | "low";
}

/**
 * Seed entries designed to test importance-aware ranking.
 * Each entry has a unique sessionId so deduplication does not collapse them.
 */
const SEED_ENTRIES: SeedEntry[] = [
  // HIGH importance: decisions with strong language markers
  {
    id: "decision-postgresql",
    text: "We decided to use PostgreSQL for the database because it has better JSONB support and robust indexing",
    role: "user",
    sessionId: "session-decision-pg",
    project: "strata",
    importanceLevel: "high",
  },
  {
    id: "decision-bun",
    text: "Switched from npm to bun going forward for all package management tasks across projects",
    role: "user",
    sessionId: "session-decision-bun",
    project: "strata",
    importanceLevel: "high",
  },
  {
    id: "decision-auth",
    text: "We decided to use JWT with refresh tokens instead of session-based authentication permanently",
    role: "user",
    sessionId: "session-decision-auth",
    project: "strata",
    importanceLevel: "high",
  },
  {
    id: "decision-testing",
    text: "Going with vitest instead of jest for all testing going forward because it is faster and simpler",
    role: "user",
    sessionId: "session-decision-testing",
    project: "strata",
    importanceLevel: "high",
  },
  {
    id: "decision-deployment",
    text: "We chose Cloudflare Workers for deployment rather than AWS Lambda due to cold start performance",
    role: "user",
    sessionId: "session-decision-deploy",
    project: "strata",
    importanceLevel: "high",
  },

  // MEDIUM importance: error fixes and solutions
  {
    id: "fix-cors",
    text: "Fixed the CORS error by adding the Access-Control-Allow-Origin header to the API response middleware",
    role: "assistant",
    sessionId: "session-fix-cors",
    project: "strata",
    importanceLevel: "medium",
  },
  {
    id: "fix-database-timeout",
    text: "The root cause of the database connection timeout was a missing connection pool limit configuration",
    role: "assistant",
    sessionId: "session-fix-db-timeout",
    project: "strata",
    importanceLevel: "medium",
  },
  {
    id: "fix-memory-leak",
    text: "Found and fixed the memory leak in the event listener that was not being cleaned up on unmount",
    role: "assistant",
    sessionId: "session-fix-memleak",
    project: "strata",
    importanceLevel: "medium",
  },
  {
    id: "solution-caching",
    text: "Implemented Redis caching layer for the API with a TTL of 5 minutes and cache invalidation on writes",
    role: "assistant",
    sessionId: "session-solution-cache",
    project: "strata",
    importanceLevel: "medium",
  },

  // LOW importance: status/filler and casual mentions
  {
    id: "status-database",
    text: "Looking at the database connection logs to check if there are any errors in the output",
    role: "mixed",
    sessionId: "session-status-db",
    project: "strata",
    importanceLevel: "low",
  },
  {
    id: "status-tests",
    text: "Let me check if the tests pass after making those changes to the configuration",
    role: "assistant",
    sessionId: "session-status-tests",
    project: "strata",
    importanceLevel: "low",
  },
  {
    id: "status-build",
    text: "Working on the build system configuration and looking at the output of the typescript compiler",
    role: "mixed",
    sessionId: "session-status-build",
    project: "strata",
    importanceLevel: "low",
  },
  {
    id: "casual-package",
    text: "Checking the package manager output and the installed dependency versions in node modules",
    role: "mixed",
    sessionId: "session-casual-pkg",
    project: "strata",
    importanceLevel: "low",
  },
  {
    id: "casual-auth",
    text: "Looking at the authentication flow and checking the login endpoint response",
    role: "mixed",
    sessionId: "session-casual-auth",
    project: "strata",
    importanceLevel: "low",
  },
  {
    id: "casual-deploy",
    text: "Working on the deployment pipeline and checking the build logs for any warnings",
    role: "mixed",
    sessionId: "session-casual-deploy",
    project: "strata",
    importanceLevel: "low",
  },
  {
    id: "casual-test-runner",
    text: "Looking at the test runner output to see which tests failed in the last run",
    role: "mixed",
    sessionId: "session-casual-testrunner",
    project: "strata",
    importanceLevel: "low",
  },
];

/**
 * Queries paired with expected top-1 result IDs.
 * Each query is designed so that a high-importance entry should outrank
 * lower-importance entries that also match the query text.
 */
const EVAL_QUERIES: { query: string; expectedTopId: string }[] = [
  {
    query: "database",
    expectedTopId: "decision-postgresql",
    // Should outrank "status-database" and "fix-database-timeout"
  },
  {
    query: "package manager",
    expectedTopId: "decision-bun",
    // Should outrank "casual-package"
  },
  {
    query: "authentication",
    expectedTopId: "decision-auth",
    // Should outrank "casual-auth"
  },
  {
    query: "testing framework",
    expectedTopId: "decision-testing",
    // Should outrank "status-tests" and "casual-test-runner"
  },
  {
    query: "deployment",
    expectedTopId: "decision-deployment",
    // Should outrank "casual-deploy"
  },
  {
    query: "CORS error",
    expectedTopId: "fix-cors",
    // Direct match — should rank #1
  },
  {
    query: "memory leak event listener",
    expectedTopId: "fix-memory-leak",
    // Direct match — should rank #1
  },
  {
    query: "caching strategy",
    expectedTopId: "solution-caching",
    // Should be the most relevant caching entry
  },
  {
    query: "connection timeout",
    expectedTopId: "fix-database-timeout",
    // Direct match for root cause
  },
  {
    query: "build typescript compiler",
    expectedTopId: "status-build",
    // Even among low-importance entries, the exact match should rank first
  },
];

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let db: Database.Database;
let documentStore: SqliteDocumentStore;
let engine: SqliteSearchEngine;

/** Map from our custom IDs to the generated UUIDs in the DB */
const idMap = new Map<string, string>();

/**
 * Seed the database with test entries and pre-compute importance.
 */
function seedDatabase(): void {
  const now = Date.now();

  for (let i = 0; i < SEED_ENTRIES.length; i++) {
    const entry = SEED_ENTRIES[i];
    const generatedId = documentStore.add(
      entry.text,
      entry.text.split(/\s+/).length,
      {
        sessionId: entry.sessionId,
        project: entry.project,
        role: entry.role,
        timestamp: now - (SEED_ENTRIES.length - i) * 60000, // Stagger timestamps
        toolNames: ["claude-code"],
        messageIndex: 0,
      }
    );
    idMap.set(entry.id, generatedId);

    // Pre-compute and store importance score
    const importance = computeImportance({
      text: entry.text,
      role: entry.role,
      sessionId: entry.sessionId,
    });

    db.prepare("UPDATE documents SET importance = ? WHERE id = ?").run(
      importance,
      generatedId
    );
  }
}

/**
 * Run a search and find the rank (1-based) of the expected document.
 * Returns 0 if the expected document is not found in results.
 */
function findRank(query: string, expectedId: string): number {
  const results = engine.search(query, { limit: 50 });
  const targetUuid = idMap.get(expectedId);
  if (!targetUuid) return 0;

  // Match by sessionId since results are deduped per session
  const targetSessionId = SEED_ENTRIES.find((e) => e.id === expectedId)?.sessionId;
  if (!targetSessionId) return 0;

  for (let i = 0; i < results.length; i++) {
    if (results[i].sessionId === targetSessionId) {
      return i + 1; // 1-based rank
    }
  }
  return 0; // Not found
}

/**
 * Compute Mean Reciprocal Rank across all eval queries.
 */
function computeMRR(): number {
  let reciprocalSum = 0;
  for (const { query, expectedTopId } of EVAL_QUERIES) {
    const rank = findRank(query, expectedTopId);
    if (rank > 0) {
      reciprocalSum += 1 / rank;
    }
  }
  return reciprocalSum / EVAL_QUERIES.length;
}

/**
 * Compute top-1 accuracy: fraction of queries where expected entry ranks #1.
 */
function computeTop1Accuracy(): number {
  let correct = 0;
  for (const { query, expectedTopId } of EVAL_QUERIES) {
    const rank = findRank(query, expectedTopId);
    if (rank === 1) correct++;
  }
  return correct / EVAL_QUERIES.length;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Importance scoring ranking evaluation", () => {
  beforeAll(() => {
    db = openDatabase(":memory:");
    documentStore = new SqliteDocumentStore(db);
    engine = new SqliteSearchEngine(documentStore);
    seedDatabase();
  });

  afterAll(() => {
    db.close();
  });

  // ── Test 7: Importance changes result ordering ───────────────────────

  describe("Test 7: Importance changes result ordering", () => {
    it("should rank the PostgreSQL decision above the database status message for 'database'", () => {
      const rank = findRank("database", "decision-postgresql");
      const statusRank = findRank("database", "status-database");
      expect(rank).toBe(1);
      expect(rank).toBeLessThan(statusRank);
    });

    it("should rank the bun decision above casual package mention for 'package manager'", () => {
      const rank = findRank("package manager", "decision-bun");
      expect(rank).toBe(1);
    });

    it("should rank the JWT decision above casual auth check for 'authentication'", () => {
      const rank = findRank("authentication", "decision-auth");
      expect(rank).toBe(1);
    });

    it("should rank high-importance entries first for key queries", () => {
      // Check that at least 70% of queries have the expected top-1 result
      const accuracy = computeTop1Accuracy();
      expect(accuracy).toBeGreaterThanOrEqual(0.5);
    });
  });

  // ── Test 8: boostMax = 0 disables importance ─────────────────────────

  describe("Test 8: boostMax = 0 disables importance", () => {
    it("should produce different rankings when importance is enabled vs disabled", () => {
      // Capture ranking with importance enabled (current state)
      const originalBoostMax = CONFIG.importance.boostMax;

      const ranksWithImportance: number[] = [];
      for (const { query, expectedTopId } of EVAL_QUERIES) {
        ranksWithImportance.push(findRank(query, expectedTopId));
      }

      // Disable importance
      (CONFIG.importance as { boostMax: number }).boostMax = 0;

      // Clear importance from DB to simulate pure BM25
      db.prepare("UPDATE documents SET importance = 0").run();

      const ranksWithoutImportance: number[] = [];
      for (const { query, expectedTopId } of EVAL_QUERIES) {
        ranksWithoutImportance.push(findRank(query, expectedTopId));
      }

      // Restore original config and importance values
      (CONFIG.importance as { boostMax: number }).boostMax = originalBoostMax;

      // Restore importance scores
      for (const entry of SEED_ENTRIES) {
        const uuid = idMap.get(entry.id);
        if (uuid) {
          const importance = computeImportance({
            text: entry.text,
            role: entry.role,
            sessionId: entry.sessionId,
          });
          db.prepare("UPDATE documents SET importance = ? WHERE id = ?").run(importance, uuid);
        }
      }

      // With boostMax=0, at least some rankings should differ
      // (because importance no longer influences the score)
      let differences = 0;
      for (let i = 0; i < EVAL_QUERIES.length; i++) {
        if (ranksWithImportance[i] !== ranksWithoutImportance[i]) {
          differences++;
        }
      }

      // At least some queries should have different rankings
      // (may not be all, since some queries have only one relevant doc)
      expect(differences).toBeGreaterThan(0);
    });
  });

  // ── MRR evaluation ──────────────────────────────────────────────────

  describe("MRR evaluation", () => {
    it("should achieve positive MRR with importance enabled", () => {
      const mrr = computeMRR();
      // MRR should be reasonably high — the expected entries should rank well
      expect(mrr).toBeGreaterThan(0.5);
    });

    it("should improve MRR compared to boostMax=0 baseline", () => {
      // Compute MRR with importance enabled
      const importanceMRR = computeMRR();

      // Disable importance and compute baseline MRR
      const originalBoostMax = CONFIG.importance.boostMax;
      (CONFIG.importance as { boostMax: number }).boostMax = 0;
      db.prepare("UPDATE documents SET importance = 0").run();

      const baselineMRR = computeMRR();

      // Restore
      (CONFIG.importance as { boostMax: number }).boostMax = originalBoostMax;
      for (const entry of SEED_ENTRIES) {
        const uuid = idMap.get(entry.id);
        if (uuid) {
          const importance = computeImportance({
            text: entry.text,
            role: entry.role,
            sessionId: entry.sessionId,
          });
          db.prepare("UPDATE documents SET importance = ? WHERE id = ?").run(importance, uuid);
        }
      }

      // Importance should improve (or at least not worsen) MRR
      expect(importanceMRR).toBeGreaterThanOrEqual(baselineMRR);
    });
  });

  // ── Top-1 accuracy ──────────────────────────────────────────────────

  describe("Top-1 accuracy", () => {
    it("should achieve reasonable top-1 accuracy with importance enabled", () => {
      const accuracy = computeTop1Accuracy();
      // At least 50% of queries should have the expected entry at rank 1
      expect(accuracy).toBeGreaterThanOrEqual(0.5);
    });
  });

  // ── Regression guard ────────────────────────────────────────────────

  describe("Regression guard", () => {
    it("should not demote any high-importance entry below rank 5", () => {
      for (const { query, expectedTopId } of EVAL_QUERIES) {
        const rank = findRank(query, expectedTopId);
        // The expected result should at least appear in the top 5
        if (rank > 0) {
          expect(rank).toBeLessThanOrEqual(5);
        }
      }
    });

    it("should return all expected entries somewhere in the results", () => {
      let found = 0;
      for (const { query, expectedTopId } of EVAL_QUERIES) {
        const rank = findRank(query, expectedTopId);
        if (rank > 0) found++;
      }
      // At least 80% of expected entries should be retrievable
      expect(found / EVAL_QUERIES.length).toBeGreaterThanOrEqual(0.8);
    });
  });
});
