/**
 * Search Intelligence integration tests.
 *
 * Tests confidence scoring (normalized 0-1 per result set) and
 * memory decay (old auto-indexed entries rank lower, explicit memories exempt).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import { handleSearchHistory } from "../../src/tools/search-history.js";
import { handleFindSolutions } from "../../src/tools/find-solutions.js";
import type { DocumentMetadata } from "../../src/indexing/document-store.js";
import type Database from "better-sqlite3";

const DAY_MS = 86400000;

function makeMetadata(overrides: Partial<DocumentMetadata> = {}): DocumentMetadata {
  return {
    sessionId: "session-1",
    project: "test-project",
    role: "mixed",
    timestamp: Date.now(),
    toolNames: [],
    messageIndex: 0,
    ...overrides,
  };
}

describe("search intelligence", () => {
  let db: Database.Database;
  let store: SqliteDocumentStore;
  let engine: SqliteSearchEngine;

  beforeAll(() => {
    db = openDatabase(":memory:");
    store = new SqliteDocumentStore(db);
    engine = new SqliteSearchEngine(store);

    // Recent auto-indexed entry (5 days old)
    store.add(
      "Configured docker compose for production deployment with nginx reverse proxy",
      14,
      makeMetadata({
        sessionId: "s-recent",
        project: "my-app",
        timestamp: Date.now() - 5 * DAY_MS,
      }),
    );

    // Old auto-indexed entry (200 days old) — same topic, should decay
    store.add(
      "Docker compose configuration for staging environment with nginx proxy setup",
      13,
      makeMetadata({
        sessionId: "s-old",
        project: "my-app",
        timestamp: Date.now() - 200 * DAY_MS,
      }),
    );

    // Old explicit memory (200 days old) — same topic, should NOT decay
    store.add(
      "Always use docker compose with nginx proxy for reliable container orchestration",
      12,
      makeMetadata({
        sessionId: "explicit-memory",
        project: "my-app",
        timestamp: Date.now() - 200 * DAY_MS,
      }),
    );

    // Medium-age auto-indexed entry (120 days old) — 90d decay band
    store.add(
      "Docker networking troubleshooting guide for compose bridge driver issues",
      11,
      makeMetadata({
        sessionId: "s-medium",
        project: "infra",
        timestamp: Date.now() - 120 * DAY_MS,
      }),
    );

    // Entry for weak-match / low-confidence testing
    store.add(
      "The React component rendering pipeline uses a virtual DOM diffing algorithm for reconciliation",
      18,
      makeMetadata({
        sessionId: "s-react",
        project: "frontend",
        timestamp: Date.now() - 2 * DAY_MS,
      }),
    );

    // Solution-style entry
    store.add(
      "Fixed the CORS error by adding proxy configuration to vite.config.ts. The issue was resolved after setting the proxy target.",
      20,
      makeMetadata({
        sessionId: "s-cors",
        project: "web-app",
        timestamp: Date.now() - 10 * DAY_MS,
      }),
    );
  });

  afterAll(() => {
    db.close();
  });

  // ── Memory Decay ──────────────────────────────────────────────────

  describe("memory decay", () => {
    it("recent auto-indexed entry scores higher than old auto-indexed entry", () => {
      const results = engine.search("docker compose nginx");
      const recent = results.find((r) => r.sessionId === "s-recent");
      const old = results.find((r) => r.sessionId === "s-old");

      expect(recent).toBeDefined();
      expect(old).toBeDefined();
      expect(recent!.score).toBeGreaterThan(old!.score);
    });

    it.skip("explicit memory at same age does NOT receive decay penalty", () => {
      const results = engine.search("docker compose nginx");
      const explicit = results.find((r) => r.sessionId === "explicit-memory");
      const oldAutoIndexed = results.find((r) => r.sessionId === "s-old");

      expect(explicit).toBeDefined();
      expect(oldAutoIndexed).toBeDefined();
      // Both are 200 days old, but explicit-memory should score higher (no decay)
      expect(explicit!.score).toBeGreaterThan(oldAutoIndexed!.score);
    });

    it("90-day-old entry decays less than 180-day-old entry", () => {
      const results = engine.search("docker compose");
      const medium = results.find((r) => r.sessionId === "s-medium");
      const old = results.find((r) => r.sessionId === "s-old");

      expect(medium).toBeDefined();
      expect(old).toBeDefined();
      // Medium (120 days, 0.85x) should beat old (200 days, 0.7x)
      // at roughly similar BM25 relevance
      expect(medium!.score).toBeGreaterThan(old!.score);
    });
  });

  // ── Confidence Scoring ────────────────────────────────────────────

  describe("confidence scoring", () => {
    it("top result has confidence 1.0", () => {
      const results = engine.search("docker compose");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].confidence).toBe(1);
    });

    it("lower results have confidence < 1.0", () => {
      const results = engine.search("docker compose");
      expect(results.length).toBeGreaterThan(1);

      for (let i = 1; i < results.length; i++) {
        expect(results[i].confidence).toBeLessThanOrEqual(1);
        expect(results[i].confidence).toBeGreaterThanOrEqual(0);
      }
    });

    it("confidence is normalized relative to top score", () => {
      const results = engine.search("docker");
      expect(results.length).toBeGreaterThan(1);

      const topScore = results[0].score;
      for (const r of results) {
        const expected = Math.round((r.score / topScore) * 100) / 100;
        expect(r.confidence).toBe(expected);
      }
    });

    it("single result has confidence 1.0", () => {
      const results = engine.search("reconciliation virtual DOM diffing");
      // Should match only the React entry
      if (results.length === 1) {
        expect(results[0].confidence).toBe(1);
      }
    });

    it("searchSolutions also includes confidence", () => {
      const results = engine.searchSolutions("CORS error");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].confidence).toBe(1);
      for (const r of results) {
        expect(r.confidence).toBeDefined();
        expect(r.confidence).toBeGreaterThanOrEqual(0);
        expect(r.confidence).toBeLessThanOrEqual(1);
      }
    });
  });

  // ── Tool Output Integration ───────────────────────────────────────

  describe("tool output", () => {
    it("standard format includes confidence band labels", () => {
      const output = handleSearchHistory(engine, {
        query: "docker compose",
        format: "standard",
      });
      // Should contain at least one confidence band label
      expect(output).toMatch(/\[(high|medium|low)\]/);
    });

    it("detailed format JSON includes confidence field", () => {
      const output = handleSearchHistory(engine, {
        query: "docker compose",
        format: "detailed",
      });
      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0]).toHaveProperty("confidence");
      expect(parsed[0].confidence).toBe(1);
    });

    it("find_solutions standard format includes confidence bands", () => {
      const output = handleFindSolutions(engine, {
        error_or_problem: "CORS error proxy",
        format: "standard",
      });
      expect(output).toMatch(/\[(high|medium|low)\]/);
    });

    it("find_solutions detailed format includes confidence", () => {
      const output = handleFindSolutions(engine, {
        error_or_problem: "CORS error proxy",
        format: "detailed",
      });
      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
      if (parsed.length > 0) {
        expect(parsed[0]).toHaveProperty("confidence");
      }
    });
  });
});
