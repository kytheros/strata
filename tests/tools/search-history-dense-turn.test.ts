/**
 * Test: dense-turn fusion branch in handleSearchHistory.
 *
 * Key invariant: a turn that shares ZERO lexical tokens with the query
 * (i.e., pure vector-only hit) must NOT be dropped by QDP coverage floor.
 * This is the regression guard against the QDP-eats-the-win scenario.
 *
 * Spec: 2026-06-03-dense-turn-lane-production-design §3.6.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { handleSearchHistory } from "../../src/tools/search-history.js";
import type { SqliteSearchEngine, SearchResult } from "../../src/search/sqlite-search-engine.js";
import type { IKnowledgeTurnStore, KnowledgeTurnHit } from "../../src/storage/interfaces/knowledge-turn-store.js";

// Build a minimal fake engine that returns empty search results
function fakeEngine(): SqliteSearchEngine {
  return {
    search: async () => [],
    searchTurns: async (_q: string, _opts: unknown): Promise<KnowledgeTurnHit[]> => [
      // A turn hit with ZERO lexical overlap with "electromagnetic flux capacitor"
      // (the turn content is deliberately "xyzzy plugh" — pure noise; would be
      // dropped by QDP coverage floor if the dense path re-runs QDP on turns).
      {
        row: {
          turnId: "t1",
          sessionId: "sess1",
          project: "proj",
          userId: null,
          speaker: "user",
          content: "xyzzy plugh quux frobnicate",  // zero overlap with the query
          messageIndex: 0,
          createdAt: Date.now(),
        },
        score: 0.95,
      },
    ],
    setKnowledgeTurnStore: vi.fn(),
    setEmbedder: vi.fn(),
    setVectorSearch: vi.fn(),
  } as unknown as SqliteSearchEngine;
}

function fakeTurnStore(): IKnowledgeTurnStore {
  return {} as unknown as IKnowledgeTurnStore;
}

describe("handleSearchHistory dense-turn fusion branch", () => {
  afterEach(() => {
    delete process.env.STRATA_DENSE_TURN_LANE;
  });

  it("surfaces zero-lexical-overlap turn as source='turn' SearchResult (regression guard against QDP floor)", async () => {
    process.env.STRATA_DENSE_TURN_LANE = "on"; // ensure dense lane is on

    const result = await handleSearchHistory(
      fakeEngine(),
      {
        query: "electromagnetic flux capacitor",
        limit: 10,
      },
      undefined,        // db
      undefined,        // asyncSearch
      undefined,        // knowledgeStore
      fakeTurnStore(),  // turnStore — triggers dense branch
    );

    // The zero-lexical-overlap turn must appear in the result
    // (proves QDP coverage floor was NOT applied to turn hits)
    expect(result).toContain("xyzzy plugh");
  });

  it("falls back to legacy behavior when dense lane is off", async () => {
    process.env.STRATA_DENSE_TURN_LANE = "off"; // kill-switch

    const result = await handleSearchHistory(
      fakeEngine(),
      { query: "electromagnetic flux capacitor", limit: 10 },
      undefined,
      undefined,
      undefined,
      fakeTurnStore(), // turnStore present but lane is off
    );

    // When lane is off, zero-overlap turn must NOT appear (no turn fusion)
    expect(result).not.toContain("xyzzy plugh");
  });
});
