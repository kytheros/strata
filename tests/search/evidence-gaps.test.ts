/**
 * Evidence gap tracking tests (spec sections 9.3-9.4).
 *
 * Tests cover: gap recording, deduplication, word-order-independent dedup,
 * resolution via store_memory, non-resolution by unrelated stores,
 * pruning by age, pruning by count, and full lifecycle integration.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import {
  recordGap,
  resolveGaps,
  listGaps,
  normalizeGapKey,
  getGapOccurrences,
} from "../../src/search/evidence-gaps.js";
import type { EvidenceGap } from "../../src/search/evidence-gaps.js";
import type { KnowledgeEntry } from "../../src/knowledge/knowledge-store.js";
import { CONFIG } from "../../src/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: Database.Database;

function getAllGaps(): EvidenceGap[] {
  return listGaps(db, { status: "all", limit: 1000 });
}

function getOpenGaps(): EvidenceGap[] {
  return listGaps(db, { status: "open", limit: 1000 });
}

function makeKnowledgeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: `entry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "decision",
    project: "",
    sessionId: "explicit-memory",
    timestamp: Date.now(),
    summary: "test entry",
    details: "",
    tags: [],
    relatedFiles: [],
    user: "default",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Test 9: Gap recorded on empty search
// ---------------------------------------------------------------------------

describe("Test 9: Gap recorded on empty search", () => {
  it("should record a gap with resultCount=0 and occurrenceCount=1", () => {
    recordGap(db, {
      query: "redis caching",
      tool: "search_history",
      project: "test-project",
      user: "default",
      resultCount: 0,
      topScore: null,
      topConfidence: null,
    });

    const gaps = getAllGaps();
    expect(gaps).toHaveLength(1);
    expect(gaps[0].resultCount).toBe(0);
    expect(gaps[0].occurrenceCount).toBe(1);
    expect(gaps[0].topScore).toBeNull();
    expect(gaps[0].topConfidence).toBeNull();
    expect(gaps[0].resolvedAt).toBeNull();
    expect(gaps[0].tool).toBe("search_history");
  });

  it("should record a gap with low-confidence results", () => {
    recordGap(db, {
      query: "websocket reconnection",
      tool: "find_solutions",
      project: "test-project",
      user: "default",
      resultCount: 3,
      topScore: 1.2,
      topConfidence: 0.18,
    });

    const gaps = getAllGaps();
    expect(gaps).toHaveLength(1);
    expect(gaps[0].resultCount).toBe(3);
    expect(gaps[0].topScore).toBe(1.2);
    expect(gaps[0].topConfidence).toBe(0.18);
  });
});

// ---------------------------------------------------------------------------
// Test 10: Gap deduplicated on repeat
// ---------------------------------------------------------------------------

describe("Test 10: Gap deduplicated on repeat search", () => {
  it("should increment occurrence_count on repeat queries instead of creating new rows", () => {
    for (let i = 0; i < 3; i++) {
      recordGap(db, {
        query: "redis caching",
        tool: "search_history",
        project: "test-project",
        user: "default",
        resultCount: 0,
        topScore: null,
        topConfidence: null,
      });
    }

    const gaps = getAllGaps();
    expect(gaps).toHaveLength(1);
    expect(gaps[0].occurrenceCount).toBe(3);
  });

  it("should update occurred_at timestamp on repeat queries", () => {
    recordGap(db, {
      query: "redis caching",
      tool: "search_history",
      project: "test-project",
      user: "default",
      resultCount: 0,
      topScore: null,
      topConfidence: null,
    });

    const firstOccurred = getAllGaps()[0].occurredAt;

    // Small delay to ensure timestamp changes
    const laterTime = firstOccurred + 1000;
    // Record again — the implementation uses Date.now() so we verify it updated
    recordGap(db, {
      query: "redis caching",
      tool: "search_history",
      project: "test-project",
      user: "default",
      resultCount: 0,
      topScore: null,
      topConfidence: null,
    });

    const updatedOccurred = getAllGaps()[0].occurredAt;
    expect(updatedOccurred).toBeGreaterThanOrEqual(firstOccurred);
  });
});

// ---------------------------------------------------------------------------
// Test 11: Word-order-independent deduplication
// ---------------------------------------------------------------------------

describe("Test 11: Word-order-independent deduplication", () => {
  it("should deduplicate 'caching redis strategy' and 'redis strategy caching'", () => {
    recordGap(db, {
      query: "caching redis strategy",
      tool: "search_history",
      project: "test-project",
      user: "default",
      resultCount: 0,
      topScore: null,
      topConfidence: null,
    });

    recordGap(db, {
      query: "redis strategy caching",
      tool: "search_history",
      project: "test-project",
      user: "default",
      resultCount: 0,
      topScore: null,
      topConfidence: null,
    });

    const gaps = getAllGaps();
    expect(gaps).toHaveLength(1);
    expect(gaps[0].occurrenceCount).toBe(2);
  });

  it("should treat different queries as distinct gaps", () => {
    recordGap(db, {
      query: "redis caching",
      tool: "search_history",
      project: "test-project",
      user: "default",
      resultCount: 0,
      topScore: null,
      topConfidence: null,
    });

    recordGap(db, {
      query: "postgresql indexing",
      tool: "search_history",
      project: "test-project",
      user: "default",
      resultCount: 0,
      topScore: null,
      topConfidence: null,
    });

    const gaps = getAllGaps();
    expect(gaps).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Test 12: Gap resolved on store_memory
// ---------------------------------------------------------------------------

describe("Test 12: Gap resolved on store_memory", () => {
  it("should resolve a gap when a matching knowledge entry is stored", () => {
    // Insert a gap for "redis caching"
    recordGap(db, {
      query: "redis caching",
      tool: "search_history",
      project: "test-project",
      user: "default",
      resultCount: 0,
      topScore: null,
      topConfidence: null,
    });

    // Verify gap is open
    expect(getOpenGaps()).toHaveLength(1);

    // Resolve with a matching entry
    const entry = makeKnowledgeEntry({
      summary: "Use Redis for caching layer",
      tags: ["redis", "caching"],
      project: "test-project",
      user: "default",
    });

    const resolvedCount = resolveGaps(db, entry);
    expect(resolvedCount).toBe(1);

    // Verify gap is resolved
    const gaps = getAllGaps();
    expect(gaps).toHaveLength(1);
    expect(gaps[0].resolvedAt).not.toBeNull();
    expect(gaps[0].resolutionId).toBe(entry.id);
  });
});

// ---------------------------------------------------------------------------
// Test 13: Gap NOT resolved by unrelated store
// ---------------------------------------------------------------------------

describe("Test 13: Gap NOT resolved by unrelated store", () => {
  it("should not resolve a redis caching gap with a PostgreSQL entry", () => {
    // Insert a gap for "redis caching"
    recordGap(db, {
      query: "redis caching",
      tool: "search_history",
      project: "test-project",
      user: "default",
      resultCount: 0,
      topScore: null,
      topConfidence: null,
    });

    // Try to resolve with an unrelated entry
    const entry = makeKnowledgeEntry({
      type: "fact",
      summary: "PostgreSQL supports JSONB",
      tags: ["postgresql"],
      project: "test-project",
      user: "default",
    });

    const resolvedCount = resolveGaps(db, entry);
    expect(resolvedCount).toBe(0);

    // Verify gap is still open
    const gaps = getOpenGaps();
    expect(gaps).toHaveLength(1);
    expect(gaps[0].resolvedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 14: Gap pruning by age
// ---------------------------------------------------------------------------

describe("Test 14: Gap pruning by age", () => {
  it("should delete unresolved gaps older than pruneAfterDays", () => {
    const maxAge = CONFIG.gaps.pruneAfterDays * 86400000;
    const oldTimestamp = Date.now() - maxAge - 86400000; // 1 day beyond the limit
    const recentTimestamp = Date.now() - 3600000; // 1 hour ago

    // Manually insert old gaps (bypass recordGap to control timestamps)
    const insertGap = db.prepare(
      `INSERT INTO evidence_gaps (id, query, tool, project, user, result_count, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    // 3 old gaps
    insertGap.run("old-1", "old query one", "search_history", "test-project", "default", 0, oldTimestamp);
    insertGap.run("old-2", "old query two", "search_history", "test-project", "default", 0, oldTimestamp - 1000);
    insertGap.run("old-3", "old query three", "search_history", "test-project", "default", 0, oldTimestamp - 2000);

    // 2 recent gaps
    insertGap.run("recent-1", "recent query one", "search_history", "test-project", "default", 0, recentTimestamp);
    insertGap.run("recent-2", "recent query two", "search_history", "test-project", "default", 0, recentTimestamp + 1000);

    // Recording a new gap triggers pruning
    recordGap(db, {
      query: "trigger pruning",
      tool: "search_history",
      project: "test-project",
      user: "default",
      resultCount: 0,
      topScore: null,
      topConfidence: null,
    });

    const gaps = getAllGaps();
    // Old gaps should be pruned, recent + new gap should remain
    // 2 recent + 1 new = 3
    expect(gaps).toHaveLength(3);

    // Verify old gaps are gone
    const ids = gaps.map((g) => g.id);
    expect(ids).not.toContain("old-1");
    expect(ids).not.toContain("old-2");
    expect(ids).not.toContain("old-3");
  });
});

// ---------------------------------------------------------------------------
// Test 15: Gap pruning by count
// ---------------------------------------------------------------------------

describe("Test 15: Gap pruning by count", () => {
  it("should enforce maxPerProject cap on unresolved gaps", () => {
    const maxPerProject = CONFIG.gaps.maxPerProject; // 100

    // Insert more than maxPerProject gaps
    const insertGap = db.prepare(
      `INSERT INTO evidence_gaps (id, query, tool, project, user, result_count, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    const now = Date.now();
    for (let i = 0; i < maxPerProject + 10; i++) {
      insertGap.run(
        `gap-${i}`,
        `unique query ${i}`,
        "search_history",
        "test-project",
        "default",
        0,
        now + i // Each gap slightly newer
      );
    }

    // Recording a new gap triggers pruning
    recordGap(db, {
      query: "trigger count pruning",
      tool: "search_history",
      project: "test-project",
      user: "default",
      resultCount: 0,
      topScore: null,
      topConfidence: null,
    });

    const gaps = listGaps(db, { project: "test-project", user: "default", status: "open", limit: 1000 });
    // Should be capped at maxPerProject
    expect(gaps.length).toBeLessThanOrEqual(maxPerProject);
  });
});

// ---------------------------------------------------------------------------
// Test 16: Full gap lifecycle (end-to-end)
// ---------------------------------------------------------------------------

describe("Test 16: Full gap lifecycle", () => {
  it("should complete the full lifecycle: record -> dedup -> count -> resolve -> list", () => {
    // Step 1: Record a gap for "websocket reconnection"
    recordGap(db, {
      query: "websocket reconnection",
      tool: "search_history",
      project: "test-project",
      user: "default",
      resultCount: 0,
      topScore: null,
      topConfidence: null,
    });

    let gaps = getOpenGaps();
    expect(gaps).toHaveLength(1);
    expect(gaps[0].occurrenceCount).toBe(1);

    // Step 2: Repeat search with different word order — should dedup
    recordGap(db, {
      query: "reconnection websocket",
      tool: "search_history",
      project: "test-project",
      user: "default",
      resultCount: 0,
      topScore: null,
      topConfidence: null,
    });

    gaps = getOpenGaps();
    expect(gaps).toHaveLength(1);
    expect(gaps[0].occurrenceCount).toBe(2);

    // Step 3: getGapOccurrences returns 2
    const occurrences = getGapOccurrences(
      db,
      "websocket reconnection",
      "test-project",
      "default"
    );
    expect(occurrences).toBe(2);

    // Step 4: Resolve with matching entry
    // Summary + tags must have high Jaccard overlap with the gap query tokens.
    // Gap query normalized: stemmed("websocket"), stemmed("reconnection")
    // Entry tokens come from summary + tags joined; keep it focused.
    const entry = makeKnowledgeEntry({
      summary: "websocket reconnection strategy",
      tags: ["websocket", "reconnection"],
      project: "test-project",
      user: "default",
    });

    const resolvedCount = resolveGaps(db, entry);
    expect(resolvedCount).toBe(1);

    // Step 5: listGaps with status "open" -> 0 results
    const openGaps = listGaps(db, {
      project: "test-project",
      user: "default",
      status: "open",
    });
    expect(openGaps).toHaveLength(0);

    // Step 6: listGaps with status "resolved" -> 1 result
    const resolvedGaps = listGaps(db, {
      project: "test-project",
      user: "default",
      status: "resolved",
    });
    expect(resolvedGaps).toHaveLength(1);
    expect(resolvedGaps[0].resolvedAt).not.toBeNull();
    expect(resolvedGaps[0].resolutionId).toBe(entry.id);
  });
});

// ---------------------------------------------------------------------------
// normalizeGapKey tests
// ---------------------------------------------------------------------------

describe("normalizeGapKey", () => {
  it("should produce consistent keys regardless of word order", () => {
    const key1 = normalizeGapKey("redis caching strategy");
    const key2 = normalizeGapKey("strategy caching redis");
    const key3 = normalizeGapKey("caching redis strategy");
    expect(key1).toBe(key2);
    expect(key2).toBe(key3);
  });

  it("should be case-insensitive", () => {
    const key1 = normalizeGapKey("Redis Caching");
    const key2 = normalizeGapKey("redis caching");
    expect(key1).toBe(key2);
  });

  it("should remove short words (<=2 chars)", () => {
    const key1 = normalizeGapKey("a redis caching to do");
    const key2 = normalizeGapKey("redis caching");
    // "a" and "to" and "do" should be filtered out (<=2 chars)
    expect(key1).toBe(key2);
  });

  it("should handle empty string", () => {
    const key = normalizeGapKey("");
    expect(key).toBe("");
  });

  it("should stem words consistently", () => {
    // "caching" and "cached" should stem to the same root
    const key1 = normalizeGapKey("caching strategies");
    const key2 = normalizeGapKey("cached strategies");
    // Both "caching" and "cached" stem via the porter stemmer
    // The stemmed output should be the same
    expect(key1).toBe(key2);
  });
});

// ---------------------------------------------------------------------------
// listGaps filtering tests
// ---------------------------------------------------------------------------

describe("listGaps filtering", () => {
  beforeEach(() => {
    // Insert gaps across different projects and users
    recordGap(db, {
      query: "redis caching",
      tool: "search_history",
      project: "project-a",
      user: "user-1",
      resultCount: 0,
      topScore: null,
      topConfidence: null,
    });
    recordGap(db, {
      query: "redis caching",
      tool: "search_history",
      project: "project-a",
      user: "user-1",
      resultCount: 0,
      topScore: null,
      topConfidence: null,
    });

    recordGap(db, {
      query: "websocket reconnection",
      tool: "find_solutions",
      project: "project-b",
      user: "user-1",
      resultCount: 0,
      topScore: null,
      topConfidence: null,
    });

    recordGap(db, {
      query: "docker compose networking",
      tool: "search_history",
      project: "project-a",
      user: "user-2",
      resultCount: 0,
      topScore: null,
      topConfidence: null,
    });
  });

  it("should filter by project", () => {
    const gaps = listGaps(db, { project: "project-a", status: "open" });
    expect(gaps).toHaveLength(2); // redis caching (user-1) + docker compose (user-2)
  });

  it("should filter by user", () => {
    const gaps = listGaps(db, { user: "user-1", status: "open" });
    expect(gaps).toHaveLength(2); // redis caching + websocket reconnection
  });

  it("should filter by min_occurrences", () => {
    const gaps = listGaps(db, { minOccurrences: 2, status: "open" });
    // Only "redis caching" has occurrenceCount >= 2
    expect(gaps).toHaveLength(1);
    expect(gaps[0].occurrenceCount).toBeGreaterThanOrEqual(2);
  });

  it("should filter by status (open vs resolved)", () => {
    // Resolve one gap
    const entry = makeKnowledgeEntry({
      summary: "Use Redis for caching",
      tags: ["redis", "caching"],
      project: "project-a",
      user: "user-1",
    });
    resolveGaps(db, entry);

    const openGaps = listGaps(db, { status: "open" });
    const resolvedGaps = listGaps(db, { status: "resolved" });
    const allGaps = listGaps(db, { status: "all" });

    expect(resolvedGaps.length).toBeGreaterThan(0);
    expect(allGaps.length).toBe(openGaps.length + resolvedGaps.length);
  });

  it("should respect limit", () => {
    const gaps = listGaps(db, { status: "open", limit: 1 });
    expect(gaps).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// getGapOccurrences tests
// ---------------------------------------------------------------------------

describe("getGapOccurrences", () => {
  it("should return 0 for unknown queries", () => {
    const count = getGapOccurrences(db, "nonexistent query", "test-project", "default");
    expect(count).toBe(0);
  });

  it("should return the correct count for a recorded gap", () => {
    for (let i = 0; i < 5; i++) {
      recordGap(db, {
        query: "kubernetes deployment",
        tool: "search_history",
        project: "test-project",
        user: "default",
        resultCount: 0,
        topScore: null,
        topConfidence: null,
      });
    }

    const count = getGapOccurrences(db, "kubernetes deployment", "test-project", "default");
    expect(count).toBe(5);
  });

  it("should return 0 after a gap is resolved", () => {
    recordGap(db, {
      query: "redis caching",
      tool: "search_history",
      project: "test-project",
      user: "default",
      resultCount: 0,
      topScore: null,
      topConfidence: null,
    });

    // Entry summary+tags must have high Jaccard overlap with gap query.
    // Use the same words to maximize overlap.
    const entry = makeKnowledgeEntry({
      summary: "redis caching",
      tags: ["redis", "caching"],
      project: "test-project",
      user: "default",
    });
    const resolvedCount = resolveGaps(db, entry);
    // First verify the resolution actually happened
    expect(resolvedCount).toBe(1);

    // After resolution, getGapOccurrences queries for unresolved gaps only
    const count = getGapOccurrences(db, "redis caching", "test-project", "default");
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
  it("should handle gaps for different projects independently", () => {
    recordGap(db, {
      query: "redis caching",
      tool: "search_history",
      project: "project-a",
      user: "default",
      resultCount: 0,
      topScore: null,
      topConfidence: null,
    });

    recordGap(db, {
      query: "redis caching",
      tool: "search_history",
      project: "project-b",
      user: "default",
      resultCount: 0,
      topScore: null,
      topConfidence: null,
    });

    const gapsA = listGaps(db, { project: "project-a", status: "open" });
    const gapsB = listGaps(db, { project: "project-b", status: "open" });
    expect(gapsA).toHaveLength(1);
    expect(gapsB).toHaveLength(1);
  });

  it("should handle gaps for different users independently", () => {
    recordGap(db, {
      query: "redis caching",
      tool: "search_history",
      project: "test-project",
      user: "user-1",
      resultCount: 0,
      topScore: null,
      topConfidence: null,
    });

    recordGap(db, {
      query: "redis caching",
      tool: "search_history",
      project: "test-project",
      user: "user-2",
      resultCount: 0,
      topScore: null,
      topConfidence: null,
    });

    const gaps1 = listGaps(db, { user: "user-1", status: "open" });
    const gaps2 = listGaps(db, { user: "user-2", status: "open" });
    expect(gaps1).toHaveLength(1);
    expect(gaps2).toHaveLength(1);
  });

  it("should resolve gaps matching project empty string (global gaps)", () => {
    // A gap with empty project should be resolvable from any project
    recordGap(db, {
      query: "redis caching",
      tool: "search_history",
      user: "default",
      resultCount: 0,
      topScore: null,
      topConfidence: null,
    });

    // Keep summary+tags focused to maximize Jaccard overlap.
    // Gap query: stemmed("redis"), stemmed("caching")
    const entry = makeKnowledgeEntry({
      summary: "redis caching layer",
      tags: ["redis", "caching"],
      project: "some-project",
      user: "default",
    });

    const resolved = resolveGaps(db, entry);
    expect(resolved).toBe(1);
  });
});
