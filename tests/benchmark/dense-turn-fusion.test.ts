// strata/tests/benchmark/dense-turn-fusion.test.ts
import { describe, it, expect } from "vitest";
import { fuseDenseTurnLane } from "../../benchmarks/longmemeval/dense-turn-fusion.js";
import type { SearchResult } from "../../src/search/sqlite-search-engine.js";
import type { KnowledgeTurnHit } from "../../src/storage/interfaces/knowledge-turn-store.js";

const chunk = (id: string, score: number): SearchResult => ({
  sessionId: id, project: "p", text: `chunk-${id}`, score, confidence: 1,
  timestamp: 0, toolNames: [], role: "mixed", source: "conversation",
});
const turn = (id: string, score: number): KnowledgeTurnHit => ({
  row: { turnId: id, sessionId: "sX", project: "p", userId: null, speaker: "assistant", content: `turn-${id}`, messageIndex: 0, createdAt: 0 },
  score,
});

describe("fuseDenseTurnLane", () => {
  it("returns chunks unchanged when there are no turn hits", () => {
    const chunks = [chunk("a", 3), chunk("b", 2)];
    expect(fuseDenseTurnLane(chunks, [], 10)).toEqual(chunks);
  });

  it("injects a high-ranked turn as its own SearchResult (source='turn')", () => {
    const chunks = [chunk("a", 3), chunk("b", 2), chunk("c", 1)];
    const turns = [turn("t1", 5)]; // rank-1 turn
    const out = fuseDenseTurnLane(chunks, turns, 10);
    const injected = out.find((r) => r.source === "turn");
    expect(injected).toBeDefined();
    expect(injected!.text).toBe("turn-t1");
    // result-granularity: the turn is a peer of the chunks, not collapsed into one
    expect(out.length).toBe(4);
  });

  it("caps extra turns at maxTurnResults", () => {
    const chunks = [chunk("a", 3)];
    const turns = [turn("t1", 9), turn("t2", 8), turn("t3", 7)];
    const out = fuseDenseTurnLane(chunks, turns, 2);
    expect(out.filter((r) => r.source === "turn").length).toBe(2);
  });
});
