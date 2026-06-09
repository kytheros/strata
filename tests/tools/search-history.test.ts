import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import { SqliteKnowledgeTurnStore } from "../../src/storage/sqlite-knowledge-turn-store.js";
import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import { handleSearchHistory } from "../../src/tools/search-history.js";
import type { KnowledgeEntry } from "../../src/knowledge/knowledge-store.js";
import type { DocumentMetadata } from "../../src/indexing/document-store.js";
import { CONFIG } from "../../src/config.js";

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

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2, 8)}`,
    type: "episodic",
    project: "test-project",
    sessionId: "session-1",
    timestamp: Date.now(),
    summary: "User attended an LGBTQ support group",
    details: "The user mentioned attending an LGBTQ support group meeting last Tuesday",
    tags: ["personal", "social"],
    relatedFiles: [],
    importance: 5.0,
    ...overrides,
  };
}

describe("handleSearchHistory knowledge retrieval", () => {
  let db: Database.Database;
  let docStore: SqliteDocumentStore;
  let knowledgeStore: SqliteKnowledgeStore;
  let engine: SqliteSearchEngine;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    docStore = new SqliteDocumentStore(db);
    knowledgeStore = new SqliteKnowledgeStore(db);
    engine = new SqliteSearchEngine(docStore, null, null, null, knowledgeStore);

    // Add a knowledge entry (as would happen after ingest_conversation)
    await knowledgeStore.addEntry(makeEntry());
  });

  afterEach(() => {
    db.close();
  });

  it("finds knowledge entries even when documents_fts has no matches", async () => {
    // No documents stored — only knowledge entries exist
    // search_history should still find the knowledge entry
    const result = await handleSearchHistory(
      engine,
      { query: "LGBTQ support group" },
      db,
      undefined,
      knowledgeStore
    );

    expect(result).not.toContain("No results found");
    expect(result).toContain("support group");
  });

  it("finds knowledge entries when query contains question words that fail LIKE", async () => {
    // LOCOMO-style question: "What did the user attend?"
    // The LIKE-based searchKnowledge requires ALL terms to appear as substrings.
    // "what" and "did" don't appear in the knowledge entry, so LIKE fails.
    // FTS5 with stop-word removal should find the entry via "attend".
    const result = await handleSearchHistory(
      engine,
      { query: "What group did they attend?" },
      db,
      undefined,
      knowledgeStore
    );

    // The knowledge entry has: "User attended an LGBTQ support group"
    // FTS5 should match "attend" -> "attended", "group" -> "group"
    expect(result).not.toContain("No results found");
    expect(result).toContain("support group");
  });

  it("finds knowledge entries via FTS5 for natural language questions", async () => {
    // Store a knowledge entry with a rephrased summary
    await knowledgeStore.addEntry(makeEntry({
      id: "entry-rephrase",
      summary: "Caroline researched international adoption agencies",
      details: "Caroline mentioned looking into agencies that handle international adoptions for same-sex couples",
      sessionId: "session-2",
    }));

    // LOCOMO-style question that includes function words that break LIKE
    const result = await handleSearchHistory(
      engine,
      { query: "What did Caroline research?" },
      db,
      undefined,
      knowledgeStore
    );

    expect(result).not.toContain("No results found");
    expect(result).toContain("Caroline");
  });

  it("merges knowledge results with document results", async () => {
    // Add a document that matches a different query aspect
    await docStore.add(
      "We discussed the project configuration for deployment",
      10,
      makeMetadata({ sessionId: "session-doc", project: "test-project" })
    );

    // Add a knowledge entry about a completely different topic
    await knowledgeStore.addEntry(makeEntry({
      id: "entry-different",
      summary: "User prefers dark mode in all applications",
      details: "User explicitly stated preference for dark mode UI",
      sessionId: "session-3",
    }));

    // Search for "What is the user's preferred UI theme?" — a natural language
    // question where the knowledge entry won't match LIKE (too many function words)
    // but FTS5 should match "preferred" and "UI"
    const result = await handleSearchHistory(
      engine,
      { query: "What is the user's preferred UI theme?" },
      db,
      undefined,
      knowledgeStore
    );

    expect(result).not.toContain("No results found");
    expect(result).toContain("dark mode");
  });
});

// ── retrieval_strategy parameter tests ──────────────────────────────────────

describe("handleSearchHistory retrieval_strategy", () => {
  let db: Database.Database;
  let docStore: SqliteDocumentStore;
  let knowledgeStore: SqliteKnowledgeStore;
  let turnStore: SqliteKnowledgeTurnStore;
  let engine: SqliteSearchEngine;
  let savedUseTirQdp: boolean;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    docStore = new SqliteDocumentStore(db);
    knowledgeStore = new SqliteKnowledgeStore(db);
    turnStore = new SqliteKnowledgeTurnStore(db);
    engine = new SqliteSearchEngine(docStore, null, null, null, knowledgeStore);

    // Store the original flag value and reset after each test
    savedUseTirQdp = CONFIG.search.useTirQdp;

    // Seed a knowledge entry so legacy path can return something
    await knowledgeStore.addEntry(makeEntry({
      id: "entry-strategy-test",
      summary: "LGBTQ support group meeting notes",
      details: "The user attended a weekly LGBTQ support group meeting",
      sessionId: "session-strategy",
    }));

    // Seed a turn entry so TIR+QDP path can return something
    await turnStore.insert({
      userId: "default",
      project: "test-project",
      sessionId: "session-turn-1",
      speaker: "user",
      content: "LGBTQ support group turn-level content",
      messageIndex: 0,
    });
  });

  afterEach(() => {
    // Restore CONFIG flag to avoid cross-test pollution
    (CONFIG.search as { useTirQdp: boolean }).useTirQdp = savedUseTirQdp;
    db.close();
  });

  it("omitting retrieval_strategy uses CONFIG.search.useTirQdp (back-compat)", async () => {
    // With useTirQdp=false and no param, must use legacy path (no 'source' in output)
    (CONFIG.search as { useTirQdp: boolean }).useTirQdp = false;

    const result = await handleSearchHistory(
      engine,
      { query: "LGBTQ support group" },
      db,
      undefined,
      knowledgeStore,
      turnStore,
    );

    expect(result).not.toContain("No results found");
    // Legacy path: results don't have source: "turn"
    expect(result).not.toContain('"source":"turn"');
  });

  it('retrieval_strategy: "auto" behaves identically to omitting the param', async () => {
    (CONFIG.search as { useTirQdp: boolean }).useTirQdp = false;

    const withAuto = await handleSearchHistory(
      engine,
      { query: "LGBTQ support group", retrieval_strategy: "auto" },
      db,
      undefined,
      knowledgeStore,
      turnStore,
    );
    const withOmit = await handleSearchHistory(
      engine,
      { query: "LGBTQ support group" },
      db,
      undefined,
      knowledgeStore,
      turnStore,
    );

    expect(withAuto).toBe(withOmit);
  });

  it('retrieval_strategy: "legacy" forces legacy path even when CONFIG.search.useTirQdp=true', async () => {
    (CONFIG.search as { useTirQdp: boolean }).useTirQdp = true;

    const result = await handleSearchHistory(
      engine,
      { query: "LGBTQ support group", retrieval_strategy: "legacy" },
      db,
      undefined,
      knowledgeStore,
      turnStore,
    );

    expect(result).not.toContain("No results found");
    // Legacy path results come from knowledge store; no turn-lane source discriminator
    expect(result).not.toMatch(/"source"\s*:\s*"turn"/);
  });

  it('retrieval_strategy: "tirqdp" forces TIR+QDP path even when CONFIG.search.useTirQdp=false', async () => {
    (CONFIG.search as { useTirQdp: boolean }).useTirQdp = false;

    const result = await handleSearchHistory(
      engine,
      { query: "LGBTQ support group", retrieval_strategy: "tirqdp" },
      db,
      undefined,
      knowledgeStore,
      turnStore,
    );

    expect(result).not.toContain("No results found");
    // TIR+QDP path produces results with source: "turn" from the turn lane
    expect(result).toContain("turn");
  });

  it('retrieval_strategy: "tirqdp" with no turnStore falls back to legacy gracefully', async () => {
    (CONFIG.search as { useTirQdp: boolean }).useTirQdp = false;

    // Pass no turnStore — graceful fallback
    const result = await handleSearchHistory(
      engine,
      { query: "LGBTQ support group", retrieval_strategy: "tirqdp" },
      db,
      undefined,
      knowledgeStore,
      // turnStore intentionally omitted
    );

    // Should not crash; should return results from legacy path
    expect(result).not.toContain("No results found");
    // Result should contain a note that TIR+QDP was requested but fell back
    expect(result).toContain("note");
  });
});

// ── turn recency boost tests ─────────────────────────────────────────────────

describe("handleSearchHistory — tirqdp + turn recency boost", () => {
  let db: Database.Database;
  let docStore: SqliteDocumentStore;
  let knowledgeStore: SqliteKnowledgeStore;
  let turnStore: SqliteKnowledgeTurnStore;
  let engine: SqliteSearchEngine;

  // Fixed timestamps with large delta so recency boost is decisive
  const OLDER_CREATED_AT = 1700000000000; // far past
  const NEWER_CREATED_AT = 1700604800000; // 7 days later

  // Shared content: both turns use the same tokens so BM25 scores are equal.
  // The ONLY difference between the turns is sessionId (for identification
  // in the result string) and createdAt. Equal BM25 → insertion order is the
  // tiebreak when boost is off; recency order wins when boost is on.
  const OLDER_CONTENT = "strata-nodeversion older session turn content";
  const NEWER_CONTENT = "strata-nodeversion newer session turn content";

  const originalBoostEnabled = CONFIG.search.turnRecencyBoost.enabled;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    docStore = new SqliteDocumentStore(db);
    knowledgeStore = new SqliteKnowledgeStore(db);
    turnStore = new SqliteKnowledgeTurnStore(db);
    engine = new SqliteSearchEngine(docStore, null, null, null, knowledgeStore);

    // Insert older turn first so it has the lower rowid → tie-breaks to first in BM25
    await turnStore.insert({
      userId: null,
      project: "test-project",
      sessionId: "session-older",
      speaker: "user",
      content: OLDER_CONTENT,
      messageIndex: 0,
      createdAt: OLDER_CREATED_AT,
    });

    await turnStore.insert({
      userId: null,
      project: "test-project",
      sessionId: "session-newer",
      speaker: "user",
      content: NEWER_CONTENT,
      messageIndex: 0,
      createdAt: NEWER_CREATED_AT,
    });
  });

  afterEach(() => {
    // Restore boost flag to avoid cross-test pollution
    (CONFIG.search.turnRecencyBoost as { enabled: boolean }).enabled = originalBoostEnabled;
    db.close();
  });

  it("flag off: turn lane order follows BM25 insertion order (regression guard)", async () => {
    (CONFIG.search.turnRecencyBoost as { enabled: boolean }).enabled = false;

    const result = await handleSearchHistory(
      engine,
      { query: "strata-nodeversion", retrieval_strategy: "tirqdp" },
      db,
      undefined,
      knowledgeStore,
      turnStore,
    );

    // Both should appear in results
    const olderPos = result.indexOf("older session");
    const newerPos = result.indexOf("newer session");
    expect(olderPos).toBeGreaterThanOrEqual(0);
    expect(newerPos).toBeGreaterThanOrEqual(0);
    // With boost off: older turn inserted first → lower rowid → comes first in BM25 ties
    expect(olderPos).toBeLessThan(newerPos);
  });

  it("flag on + classifier fires: newer turn ranks higher", async () => {
    (CONFIG.search.turnRecencyBoost as { enabled: boolean }).enabled = true;

    const result = await handleSearchHistory(
      engine,
      // Query fires isTemporalCurrentStateQuestion: has "version"+"node"+"now"
      { query: "What strata-nodeversion is the user on now?", retrieval_strategy: "tirqdp" },
      db,
      undefined,
      knowledgeStore,
      turnStore,
    );

    // With flag on + classifier match: newer (higher createdAt) should appear first
    const olderPos = result.indexOf("older session");
    const newerPos = result.indexOf("newer session");
    expect(olderPos).toBeGreaterThanOrEqual(0);
    expect(newerPos).toBeGreaterThanOrEqual(0);
    expect(newerPos).toBeLessThan(olderPos);
  });

  it("flag on + historical query: classifier vetoes, no reorder", async () => {
    (CONFIG.search.turnRecencyBoost as { enabled: boolean }).enabled = true;

    const result = await handleSearchHistory(
      engine,
      // Historical query: "last year" fires hasHistoricalMarker → classifier vetoes
      { query: "What strata-nodeversion did I see last year?", retrieval_strategy: "tirqdp" },
      db,
      undefined,
      knowledgeStore,
      turnStore,
    );

    // Historical query → classifier vetoes → insertion order: older first
    const olderPos = result.indexOf("older session");
    const newerPos = result.indexOf("newer session");
    expect(olderPos).toBeGreaterThanOrEqual(0);
    expect(newerPos).toBeGreaterThanOrEqual(0);
    expect(olderPos).toBeLessThan(newerPos);
  });
});

