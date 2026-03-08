import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import type { DocumentMetadata } from "../../src/indexing/document-store.js";

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

describe("SqliteSearchEngine integration", () => {
  let db: Database.Database;
  let store: SqliteDocumentStore;
  let engine: SqliteSearchEngine;

  beforeAll(() => {
    db = openDatabase(":memory:");
    store = new SqliteDocumentStore(db);
    engine = new SqliteSearchEngine(store);

    // Seed with realistic document chunks
    store.add(
      "We configured docker compose for the production deployment with nginx reverse proxy and SSL certificates",
      15,
      makeMetadata({ sessionId: "s1", project: "my-app", timestamp: Date.now() - 86400000 }),
    );
    store.add(
      "Fixed the TypeScript compilation error by adding strict null checks to the config",
      12,
      makeMetadata({ sessionId: "s2", project: "my-app", timestamp: Date.now() - 172800000, toolNames: ["Write", "Bash"] }),
    );
    store.add(
      "Implemented the search engine using BM25 algorithm with custom tokenizer and stemming",
      14,
      makeMetadata({ sessionId: "s3", project: "search-lib", timestamp: Date.now() - 259200000 }),
    );
    store.add(
      "The database migration failed because of a foreign key constraint. We solved it by disabling foreign keys temporarily during migration.",
      22,
      makeMetadata({ sessionId: "s4", project: "backend", timestamp: Date.now() - 345600000 }),
    );
    store.add(
      "Debugging the react component that was not rendering due to stale state. The issue was resolved by using useCallback properly.",
      20,
      makeMetadata({ sessionId: "s5", project: "frontend", timestamp: Date.now() }),
    );
    store.add(
      "Docker container kept crashing with OOM error. Increased memory limit in docker compose configuration.",
      15,
      makeMetadata({ sessionId: "s6", project: "my-app", timestamp: Date.now() - 50000 }),
    );
  });

  afterAll(() => {
    db.close();
  });

  it("should find results for keyword queries", () => {
    const results = engine.search("docker");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.text.toLowerCase().includes("docker"))).toBe(true);
  });

  it("should rank more relevant results higher", () => {
    const results = engine.search("docker compose");
    expect(results.length).toBeGreaterThan(0);
    // Results mentioning both "docker" and "compose" should be present
    expect(results[0].text.toLowerCase()).toContain("docker");
  });

  it("should support project filtering via inline syntax", () => {
    const results = engine.search("project:my-app docker");
    for (const r of results) {
      expect(r.project).toBe("my-app");
    }
  });

  it("should support project filtering via options", () => {
    const results = engine.search("docker", { project: "my-app" });
    for (const r of results) {
      expect(r.project).toBe("my-app");
    }
  });

  it("should respect limit parameter", () => {
    const results = engine.search("docker", { limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("should return empty for no-match queries", () => {
    const results = engine.search("xyznonexistentterm");
    expect(results).toEqual([]);
  });

  it("should return empty for empty queries", () => {
    expect(engine.search("")).toEqual([]);
    expect(engine.search("   ")).toEqual([]);
  });

  it("should deduplicate by session (best per session)", () => {
    // Add two chunks for the same session
    store.add(
      "docker networking issues with bridge driver",
      6,
      makeMetadata({ sessionId: "s-dup", project: "infra", messageIndex: 0 }),
    );
    store.add(
      "docker volume mount permissions problem",
      5,
      makeMetadata({ sessionId: "s-dup", project: "infra", messageIndex: 1 }),
    );

    const results = engine.search("docker");
    const sessionCounts = new Map<string, number>();
    for (const r of results) {
      sessionCounts.set(r.sessionId, (sessionCounts.get(r.sessionId) || 0) + 1);
    }
    // Each session should appear at most once
    for (const count of sessionCounts.values()) {
      expect(count).toBe(1);
    }
  });

  it("should find solutions with solution-biased ranking", () => {
    const results = engine.searchSolutions("migration failed");
    expect(results.length).toBeGreaterThan(0);
    // Result about migration fix should be ranked highly
    expect(results.some((r) => r.text.toLowerCase().includes("solved"))).toBe(true);
  });

  it("should boost solution results containing fix language", () => {
    const results = engine.searchSolutions("error");
    // Check that results with "fixed", "resolved", "solved" have higher scores
    const solutionResults = results.filter((r) => {
      const lower = r.text.toLowerCase();
      return lower.includes("fixed") || lower.includes("resolved") || lower.includes("solved");
    });
    const otherResults = results.filter((r) => {
      const lower = r.text.toLowerCase();
      return !lower.includes("fixed") && !lower.includes("resolved") && !lower.includes("solved");
    });

    if (solutionResults.length > 0 && otherResults.length > 0) {
      // Best solution result should score >= best other result
      expect(solutionResults[0].score).toBeGreaterThanOrEqual(otherResults[0].score);
    }
  });
});
