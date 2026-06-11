/**
 * Tests for result-ranker helpers — capChunksPerSession (#41 A3).
 */

import { describe, it, expect } from "vitest";
import { capChunksPerSession, type RankedResult } from "../../src/search/result-ranker.js";

describe("capChunksPerSession (#41 A3)", () => {
  const mk = (docId: string, sessionId: string, score: number): RankedResult =>
    ({
      docId,
      score,
      doc: {
        id: docId,
        sessionId,
        project: "p",
        text: docId,
        role: "assistant",
        timestamp: 1,
        toolNames: [],
        tokenCount: 1,
        messageIndex: 0,
      },
    } as unknown as RankedResult);

  it("caps chunks per session preserving rank order", () => {
    const input = [
      mk("a1", "A", 9),
      mk("a2", "A", 8),
      mk("a3", "A", 7),
      mk("b1", "B", 6),
      mk("a4", "A", 5),
      mk("c1", "C", 4),
    ];
    const out = capChunksPerSession(input, 2);
    expect(out.map((r) => r.docId)).toEqual(["a1", "a2", "b1", "c1"]);
  });

  it("cap<=0 disables (returns input unchanged)", () => {
    const input = [mk("a1", "A", 9), mk("a2", "A", 8)];
    expect(capChunksPerSession(input, 0)).toBe(input);
  });
});
