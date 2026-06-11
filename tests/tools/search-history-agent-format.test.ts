import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import { handleSearchHistory, buildAgentContext } from "../../src/tools/search-history.js";
import type { KnowledgeEntry } from "../../src/knowledge/knowledge-store.js";
import type { SearchResult } from "../../src/search/sqlite-search-engine.js";

describe("buildAgentContext counting guidance (C1, #37)", () => {
  const mk = (i: number): SearchResult => ({
    sessionId: `s-${i}`,
    project: "p",
    text: `note ${i} body`,
    score: 5 - i,
    confidence: 0.9,
    timestamp: Date.UTC(2026, 0, i + 1),
    toolNames: [],
    role: "assistant" as const,
  });

  it("prepends counting guidance for aggregation queries", () => {
    const out = buildAgentContext([mk(0), mk(1)], "How many plants did I acquire?", 2500);
    expect(out).toMatch(/^\[Counting guidance\]/);
    expect(out).toContain("note 0 body");
    expect(out).toContain("note 1 body");
  });

  it("does not prepend guidance for non-aggregation queries", () => {
    const out = buildAgentContext([mk(0)], "What did I decide about the migration?", 2500);
    expect(out).not.toContain("[Counting guidance]");
  });

  it("does not prepend guidance on the empty-result sentinel", () => {
    const out = buildAgentContext([], "How many plants did I acquire?", 2500);
    expect(out).toBe('No relevant memory found for "How many plants did I acquire?".');
  });
});
function entry(over: Partial<KnowledgeEntry>): KnowledgeEntry {
  return {
    id: `e-${Math.random().toString(36).slice(2, 8)}`,
    type: "episodic", project: "test-project", sessionId: "s1",
    timestamp: Date.now(), summary: "budget note",
    details: "the project budget changed", tags: [], relatedFiles: [],
    importance: 5.0, ...over,
  };
}

describe("search_history format:'agent'", () => {
  let db: Database.Database; let docStore: SqliteDocumentStore;
  let knowledgeStore: SqliteKnowledgeStore; let engine: SqliteSearchEngine;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    docStore = new SqliteDocumentStore(db);
    knowledgeStore = new SqliteKnowledgeStore(db);
    engine = new SqliteSearchEngine(docStore, null, null, null, knowledgeStore);
    // Two sessions matching "budget", inserted newest-first to prove re-sorting.
    await knowledgeStore.addEntry(entry({
      sessionId: "newer", timestamp: Date.UTC(2026, 0, 10),
      summary: "budget raised", details: "the budget was raised to 5000 dollars",
    }));
    await knowledgeStore.addEntry(entry({
      sessionId: "older", timestamp: Date.UTC(2026, 0, 1),
      summary: "budget set", details: "the budget was set to 2000 dollars",
    }));
  });
  afterEach(() => db.close());

  it("renders dated, numbered notes in CHRONOLOGICAL order (oldest first)", async () => {
    const out = await handleSearchHistory(
      engine, { query: "budget", format: "agent" }, db, undefined, knowledgeStore
    );
    expect(out).toMatch(/Note 1 \(2026-01-01\):/);
    expect(out).toMatch(/Note 2 \(2026-01-10\):/);
    // Note 1 (older, 2000) must appear before Note 2 (newer, 5000)
    expect(out.indexOf("2000")).toBeLessThan(out.indexOf("5000"));
  });

  it("strips relevance-rank chrome (no 'Found', no '---' headers, no bands)", async () => {
    const out = await handleSearchHistory(
      engine, { query: "budget", format: "agent" }, db, undefined, knowledgeStore
    );
    expect(out).not.toContain("Found ");
    expect(out).not.toContain("---");
    expect(out).not.toMatch(/\[(high|medium|low)\]/i);
  });

  it("returns a clear sentinel when there are no results", async () => {
    const out = await handleSearchHistory(
      engine, { query: "zzz-nonexistent-term-qqq", format: "agent" }, db, undefined, knowledgeStore
    );
    expect(out).toContain("No relevant memory found");
  });
});

// ── buildAgentContext unit tests ──────────────────────────────────────────────

function sr(over: Partial<SearchResult>): SearchResult {
  return {
    sessionId: "s1", project: "p", text: "hello world", score: 1, confidence: 1,
    timestamp: Date.UTC(2026, 0, 1), toolNames: [], role: "mixed", ...over,
  };
}

describe("buildAgentContext", () => {
  it("single result renders 'Note 1 (<date>):' and the text", () => {
    const out = buildAgentContext(
      [sr({ text: "the budget was 2000", timestamp: Date.UTC(2026, 0, 1) })],
      "budget",
      2500,
    );
    expect(out).toMatch(/^Note 1 \(2026-01-01\):/m);
    expect(out).toContain("the budget was 2000");
  });

  it("result with NaN timestamp renders 'Note N (Unknown date):' and sorts LAST when mixed with finite-timestamp result", () => {
    const out = buildAgentContext(
      [
        sr({ sessionId: "nan-session", text: "unknown-time note", timestamp: NaN }),
        sr({ sessionId: "finite-session", text: "known-time note", timestamp: Date.UTC(2026, 0, 1) }),
      ],
      "note",
      2500,
    );
    // NaN-timestamp result should be labelled "Unknown date"
    expect(out).toContain("Unknown date");
    // Finite-timestamp result must appear BEFORE the NaN-timestamp result (chronological: NaN sorts last)
    expect(out.indexOf("known-time note")).toBeLessThan(out.indexOf("unknown-time note"));
  });

  it("truncates result text to maxChars + '...'", () => {
    const longText = "x".repeat(200);
    const out = buildAgentContext(
      [sr({ text: longText })],
      "x",
      50,
    );
    expect(out).toContain("x".repeat(50) + "...");
    // Should not contain the full 200-char string untruncated
    expect(out).not.toContain("x".repeat(51) + "x");
  });

  it("empty array returns the 'No relevant memory found' sentinel", () => {
    const out = buildAgentContext([], "anything", 2500);
    expect(out).toContain("No relevant memory found");
  });
});
