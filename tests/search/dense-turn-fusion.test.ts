import { describe, it, expect } from "vitest";
import { fuseDenseTurnLane } from "../../src/search/dense-turn-fusion.js";
import type { SearchResult } from "../../src/search/sqlite-search-engine.js";
import type { KnowledgeTurnHit } from "../../src/storage/interfaces/knowledge-turn-store.js";

describe("fuseDenseTurnLane", () => {
  it("fuses chunk results and turn hits, producing source:'turn' entries", () => {
    const chunks: SearchResult[] = [
      { sessionId: "s1", project: "p", text: "chunk text", score: 0.9, confidence: 1, timestamp: 1000, toolNames: [], role: "user", source: "conversation" },
      { sessionId: "s2", project: "p", text: "chunk text 2", score: 0.7, confidence: 0.8, timestamp: 2000, toolNames: [], role: "assistant", source: "conversation" },
    ];
    const now = Date.now();
    const turnHits: KnowledgeTurnHit[] = [
      {
        row: { turnId: "t1", sessionId: "s3", project: "p", userId: null, speaker: "user", content: "turn text", messageIndex: 0, createdAt: now },
        score: 0.8,
      },
    ];

    const result = fuseDenseTurnLane(chunks, turnHits, 10);

    // Should have entries from both chunks and turns
    expect(result.length).toBe(3);
    const turnResults = result.filter(r => r.source === "turn");
    const chunkResults = result.filter(r => r.source !== "turn");
    expect(turnResults.length).toBe(1);
    expect(chunkResults.length).toBe(2);
    expect(turnResults[0].text).toBe("turn text");
    expect(turnResults[0].role).toBe("user");
    expect(turnResults[0].sessionId).toBe("s3");
  });

  it("returns chunk results unchanged when turnHits is empty", () => {
    const chunks: SearchResult[] = [
      { sessionId: "s1", project: "p", text: "chunk text", score: 0.9, confidence: 1, timestamp: 1000, toolNames: [], role: "user" },
    ];
    const result = fuseDenseTurnLane(chunks, [], 10);
    expect(result).toBe(chunks); // exact same reference
  });

  it("respects maxTurnResults cap", () => {
    const chunks: SearchResult[] = [];
    const turnHits: KnowledgeTurnHit[] = Array.from({ length: 5 }, (_, i) => ({
      row: { turnId: `t${i}`, sessionId: "s1", project: "p", userId: null, speaker: "user", content: `turn ${i}`, messageIndex: i, createdAt: 1000 + i },
      score: 0.5,
    }));

    // maxTurnResults = 2 — only top 2 turns should be included
    const result = fuseDenseTurnLane(chunks, turnHits, 2);
    expect(result.filter(r => r.source === "turn").length).toBe(2);
  });
});
