/**
 * Tests for TIRQDP-2.1 — useTirQdp flag dispatch in search_history.
 *
 * Sub-task A of #5:
 *   - When useTirQdp === false → legacy path, no source: "turn" results
 *   - When useTirQdp === true  → fuseCommunityLanes + recallQdpCommunity path,
 *     at least one result carries source: "turn"
 *
 * Spec: 2026-05-01-tirqdp-community-port-plan.md §TIRQDP-2.1
 * Ticket: kytheros/strata#5
 */

import { describe, it, expect, beforeEach, afterEach, vi, afterAll } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import { SqliteKnowledgeTurnStore } from "../../src/storage/sqlite-knowledge-turn-store.js";
import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import { handleSearchHistory } from "../../src/tools/search-history.js";
import { CONFIG } from "../../src/config.js";
import type { KnowledgeEntry } from "../../src/knowledge/knowledge-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2, 8)}`,
    type: "episodic",
    project: "tirqdp-test",
    sessionId: "session-chunk",
    timestamp: Date.now(),
    summary: "User deployed a Rust service to production",
    details: "The user deployed a Rust microservice to production after fixing a memory safety bug",
    tags: ["deployment", "rust"],
    relatedFiles: [],
    importance: 7.0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("search_history TIR+QDP flag dispatch (TIRQDP-2.1)", () => {
  let db: Database.Database;
  let docStore: SqliteDocumentStore;
  let knowledgeStore: SqliteKnowledgeStore;
  let turnStore: SqliteKnowledgeTurnStore;
  let engine: SqliteSearchEngine;

  // Save original flag so we can restore it after each test
  const originalFlag = CONFIG.search.useTirQdp;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    docStore = new SqliteDocumentStore(db);
    knowledgeStore = new SqliteKnowledgeStore(db);
    turnStore = new SqliteKnowledgeTurnStore(db);
    engine = new SqliteSearchEngine(docStore, null, null, null, knowledgeStore);

    // Seed a knowledge entry (chunk lane)
    await knowledgeStore.addEntry(makeEntry({
      summary: "User deployed a Rust service to production",
      details: "The user deployed a Rust microservice to production after fixing a memory safety bug",
    }));

    // Seed a knowledge_turn (turn lane)
    await turnStore.insert({
      sessionId: "session-turn",
      project: "tirqdp-test",
      userId: null,
      speaker: "user",
      content: "I just finished deploying the Rust service to production servers",
      messageIndex: 0,
    });
  });

  afterEach(() => {
    // Restore flag to its original value
    CONFIG.search.useTirQdp = originalFlag;
    db.close();
  });

  // ── regression guard: legacy path unchanged when flag is off ────────────

  it("legacy path (useTirQdp=false) returns results without source: 'turn'", async () => {
    CONFIG.search.useTirQdp = false;

    const result = await handleSearchHistory(
      engine,
      { query: "Rust service deployment" },
      db,
      undefined,
      knowledgeStore,
      // turnStore NOT passed — flag=false callers don't need it
    );

    expect(result).not.toContain("No results found");
    // The legacy path returns chunk-level results only — no turn lane
    expect(result).not.toContain('"source":"turn"');
    expect(result).not.toContain("source: turn");
  });

  // ── new path: turn lane reached when flag is on ─────────────────────────

  it("TIR+QDP path (useTirQdp=true) returns at least one result with source: 'turn'", async () => {
    CONFIG.search.useTirQdp = true;

    const result = await handleSearchHistory(
      engine,
      { query: "Rust service deployment", format: "detailed" },
      db,
      undefined,
      knowledgeStore,
      turnStore,
    );

    expect(result).not.toContain("No results found");
    // The new lane must produce at least one result tagged with source "turn"
    expect(result).toContain("turn");
  });

  // ── when turnStore is omitted even with flag=true, graceful degradation ─

  it("TIR+QDP path (useTirQdp=true) without turnStore falls back gracefully", async () => {
    CONFIG.search.useTirQdp = true;

    const result = await handleSearchHistory(
      engine,
      { query: "Rust service deployment" },
      db,
      undefined,
      knowledgeStore,
      // no turnStore — should fall back to legacy, not throw
    );

    // Should not throw and should still find the chunk-based result
    expect(result).not.toContain("No results found");
  });
});
