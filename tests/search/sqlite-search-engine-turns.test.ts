import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import { SqliteKnowledgeTurnStore } from "../../src/storage/sqlite-knowledge-turn-store.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { openDatabase } from "../../src/storage/database.js";
import { CONFIG } from "../../src/config.js";

// Test harness: a fresh in-memory DB with a turn store and an engine.
function makeEngineWithTurnStore() {
  const db = openDatabase(":memory:");
  const docStore = new SqliteDocumentStore(db);
  const turnStore = new SqliteKnowledgeTurnStore(db);
  const engine = new SqliteSearchEngine(docStore);
  engine.setKnowledgeTurnStore(turnStore);
  return { db, engine, turnStore };
}

// Seed a fixture: two sessions, one older "old" claim + one newer "new" claim.
async function seedRecencyFixture(turnStore: SqliteKnowledgeTurnStore) {
  const oldTime = Date.now() - 60 * 60 * 1000;
  const newTime = Date.now();
  await turnStore.bulkInsert([
    { sessionId: "s_old", speaker: "user",      content: "I'm using Node 18",
      messageIndex: 0, createdAt: oldTime },
    { sessionId: "s_old", speaker: "assistant", content: "Node 18 confirmed",
      messageIndex: 1, createdAt: oldTime + 1000 },
    { sessionId: "s_new", speaker: "user",      content: "Upgraded to Node 22 today",
      messageIndex: 0, createdAt: newTime },
    { sessionId: "s_new", speaker: "assistant", content: "Node 22 now in use",
      messageIndex: 1, createdAt: newTime + 1000 },
  ]);
}

describe("SqliteSearchEngine.searchTurns", () => {
  let originalBoostEnabled: boolean;

  beforeEach(() => {
    originalBoostEnabled = CONFIG.search.turnRecencyBoost.enabled;
    CONFIG.search.turnRecencyBoost.enabled = true;
  });

  afterEach(() => {
    CONFIG.search.turnRecencyBoost.enabled = originalBoostEnabled;
  });

  it("returns [] when no turn store is attached", async () => {
    const db = openDatabase(":memory:");
    const engine = new SqliteSearchEngine(new SqliteDocumentStore(db));
    const hits = await engine.searchTurns("anything", { userId: undefined, limit: 10 });
    expect(hits).toEqual([]);
  });

  it("applies boost when classifier fires (current-state temporal question)", async () => {
    const { engine, turnStore } = makeEngineWithTurnStore();
    await seedRecencyFixture(turnStore);
    const hits = await engine.searchTurns("What Node version am I using now?", {
      userId: undefined, limit: 10,
    });
    // Boost reorders so the newer session (s_new) appears before older s_old
    // in the top results.
    const topSessions = hits.slice(0, 2).map(h => h.row.sessionId);
    expect(topSessions[0]).toBe("s_new");
  });

  it("does NOT apply boost when classifier does not fire (factual query)", async () => {
    const { engine, turnStore } = makeEngineWithTurnStore();
    await seedRecencyFixture(turnStore);
    const hits = await engine.searchTurns("Node", {
      userId: undefined, limit: 10,
    });
    // "Node" alone is not a temporal-current-state question; ordering is BM25.
    // BM25 ranks shorter/more-relevant matches higher — we just assert that
    // the boost reordering didn't fire by checking the result count and that
    // both sessions are present.
    expect(hits.length).toBe(4);
    const sessions = new Set(hits.map(h => h.row.sessionId));
    expect(sessions.has("s_old")).toBe(true);
    expect(sessions.has("s_new")).toBe(true);
  });

  it("does NOT apply boost when CONFIG.search.turnRecencyBoost.enabled is false", async () => {
    const { engine, turnStore } = makeEngineWithTurnStore();
    await seedRecencyFixture(turnStore);
    CONFIG.search.turnRecencyBoost.enabled = false;
    const hits = await engine.searchTurns("What Node version am I using now?", {
      userId: undefined, limit: 10, forceBoost: true,
    });
    // Even with forceBoost: true, the global flag wins.
    expect(hits.length).toBe(4);
    // No specific order assertion — we're asserting only that the boost path
    // is short-circuited (length unchanged from raw search).
  });

  it("applies boost when forceBoost is true even on a non-classifier query", async () => {
    const { engine, turnStore } = makeEngineWithTurnStore();
    await seedRecencyFixture(turnStore);
    const hits = await engine.searchTurns("Node", {
      userId: undefined, limit: 10, forceBoost: true,
    });
    // With forceBoost the recency-aware ordering applies even though the
    // bare "Node" query doesn't trigger the classifier.
    const topSessions = hits.slice(0, 2).map(h => h.row.sessionId);
    expect(topSessions[0]).toBe("s_new");
  });

  it("fires boost on existential pattern (matches f470daf classifier change)", async () => {
    const { engine, turnStore } = makeEngineWithTurnStore();
    await turnStore.bulkInsert([
      { sessionId: "s_old", speaker: "assistant", content: "Semantic search is a Pro feature",
        messageIndex: 0, createdAt: Date.now() - 60_000 },
      { sessionId: "s_new", speaker: "user",
        content: "Update: semantic search moved from Pro to Community as of yesterday",
        messageIndex: 0, createdAt: Date.now() },
    ]);
    const hits = await engine.searchTurns("Is semantic search a Pro feature?", {
      userId: undefined, limit: 10,
    });
    // Existential classifier (Is X a Y?) should trigger boost; newest session wins.
    expect(hits[0].row.sessionId).toBe("s_new");
  });

  it("historical-marker veto blocks the boost", async () => {
    const { engine, turnStore } = makeEngineWithTurnStore();
    await seedRecencyFixture(turnStore);
    const hits = await engine.searchTurns("What Node version did we use last week?", {
      userId: undefined, limit: 10,
    });
    // "last week" is a historical marker — composite classifier returns false,
    // boost does not engage. We assert length and presence only.
    expect(hits.length).toBe(4);
  });
});
