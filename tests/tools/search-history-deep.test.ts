/**
 * Test: deep (session-level) branch in handleSearchHistory.
 * retrieval_strategy:"deep" must route to engine.searchSessionLevel
 * (session-scoring + reranker + events), not the chunk/dense/legacy paths.
 * Spec: 2026-06-05-readpath-parity-phase1-design §4.2/§4.3.
 */
import { describe, it, expect, vi } from "vitest";
import { handleSearchHistory } from "../../src/tools/search-history.js";
import type { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import type { IKnowledgeTurnStore, KnowledgeTurnHit } from "../../src/storage/interfaces/knowledge-turn-store.js";

function fakeEngine(onSessionLevel?: () => void): SqliteSearchEngine {
  return {
    search: async () => [
      { sessionId: "s-fts", project: "p", text: "fts chunk result", score: 1,
        confidence: 0.5, timestamp: Date.now(), toolNames: [], role: "assistant" as const },
    ],
    searchSessionLevel: async () => {
      onSessionLevel?.();
      return [
        { sessionId: "s-deep", project: "p", text: "deep session level result", score: 9,
          confidence: 0.9, timestamp: Date.now(), toolNames: [], role: "assistant" as const },
      ];
    },
    searchTurns: async (): Promise<KnowledgeTurnHit[]> => [],
    setKnowledgeTurnStore: vi.fn(),
    setEmbedder: vi.fn(),
    setVectorSearch: vi.fn(),
  } as unknown as SqliteSearchEngine;
}

function fakeTurnStore(): IKnowledgeTurnStore {
  return {} as unknown as IKnowledgeTurnStore;
}

describe("handleSearchHistory deep (session-level) branch", () => {
  it("routes retrieval_strategy='deep' to engine.searchSessionLevel", async () => {
    let called = false;
    const result = await handleSearchHistory(
      fakeEngine(() => { called = true; }),
      { query: "what did I decide about the database migration", limit: 10, retrieval_strategy: "deep" },
      undefined, undefined, undefined,
      fakeTurnStore(),
    );
    expect(called).toBe(true);
    expect(result).toContain("deep session level result");
  });

  it("does NOT use searchSessionLevel for retrieval_strategy='legacy'", async () => {
    let called = false;
    const result = await handleSearchHistory(
      fakeEngine(() => { called = true; }),
      { query: "what did I decide about the database migration", limit: 10, retrieval_strategy: "legacy" },
      undefined, undefined, undefined,
      fakeTurnStore(),
    );
    expect(called).toBe(false);
    expect(result).not.toContain("deep session level result");
  });
});
