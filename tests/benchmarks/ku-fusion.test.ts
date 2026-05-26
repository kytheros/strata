import { describe, it, expect } from "vitest";
import { appendUniqueByLane, rrfFuse } from "../../benchmarks/longmemeval/ku-fusion.js";
import type { SearchResult } from "../../src/search/sqlite-search-engine.js";
import type { KnowledgeTurnHit } from "../../src/storage/interfaces/knowledge-turn-store.js";
import type { IngestedQuestion } from "../../benchmarks/longmemeval/ingest.js";

// Synthetic SearchResult fixture. The strata sessionId is encoded as
// `longmemeval-{idx}` so the toLmeSessionId helper can decode it via
// strataSessionIdToIndex. The real format is: strataSessionIdToIndex("longmemeval-5") => 5.
function chunk(lmeIdx: number, score: number, text = "chunk text"): SearchResult {
  return {
    sessionId: `longmemeval-${lmeIdx}`,
    project: "test",
    text,
    score,
    confidence: Math.min(score, 1),
    timestamp: 1_700_000_000_000 + lmeIdx * 1000,
  } as SearchResult;
}

function turnHit(lmeIdx: number, score: number, content = "turn content"): KnowledgeTurnHit {
  return {
    row: {
      turnId: `t${lmeIdx}`,
      sessionId: `longmemeval-${lmeIdx}`,
      project: "test",
      userId: null,
      speaker: "user",
      content,
      messageIndex: 0,
      createdAt: 1_700_000_000_000 + lmeIdx * 1000,
    },
    score,
  };
}

const ingested = {
  indexToSessionId: Array.from({ length: 120 }, (_, i) => `lme_session_${i}`),
} as unknown as IngestedQuestion;

describe("appendUniqueByLane (M1)", () => {
  it("appends turn-lane sessions not in chunk-lane top-20", () => {
    const chunkTop = [chunk(1, 0.9), chunk(2, 0.8), chunk(3, 0.7), chunk(4, 0.6)];
    const turn = [turnHit(2, 0.85), turnHit(5, 0.80), turnHit(6, 0.75)];
    const widerNet = [...chunkTop, chunk(5, 0.5), chunk(6, 0.4), chunk(7, 0.3)];
    const out = appendUniqueByLane(chunkTop, turn, widerNet, ingested, 5);
    const sessions = out.map((c) => c.sessionId);
    // First 4 = original chunk-lane top-20; appended: 5 and 6 (new, in turn-lane)
    expect(sessions.slice(0, 4)).toEqual(chunkTop.map((c) => c.sessionId));
    expect(sessions).toContain("longmemeval-5");
    expect(sessions).toContain("longmemeval-6");
    expect(sessions).not.toContain("longmemeval-7"); // not in turn-lane
  });

  it("respects maxAppend cap when turn-lane brings >maxAppend new sessions", () => {
    const chunkTop = [chunk(1, 0.9)];
    const turn = [turnHit(2, 0), turnHit(3, 0), turnHit(4, 0), turnHit(5, 0), turnHit(6, 0), turnHit(7, 0), turnHit(8, 0)];
    const widerNet = [chunk(1, 0.9), chunk(2, 0.5), chunk(3, 0.5), chunk(4, 0.5), chunk(5, 0.5), chunk(6, 0.5), chunk(7, 0.5), chunk(8, 0.5)];
    const out = appendUniqueByLane(chunkTop, turn, widerNet, ingested, 3);
    const sessions = out.map((c) => c.sessionId);
    expect(sessions.length).toBe(1 + 3); // 1 chunk-lane + 3 turn-lane extras
    expect(sessions[0]).toBe("longmemeval-1");
  });

  it("returns chunk-lane unchanged when turn-lane is empty", () => {
    const chunkTop = [chunk(1, 0.9), chunk(2, 0.8)];
    const out = appendUniqueByLane(chunkTop, [], chunkTop, ingested, 5);
    expect(out).toEqual(chunkTop);
  });

  it("returns chunk-lane unchanged when turn-lane only overlaps with chunk-lane", () => {
    const chunkTop = [chunk(1, 0.9), chunk(2, 0.8)];
    const turn = [turnHit(1, 0), turnHit(2, 0)];
    const out = appendUniqueByLane(chunkTop, turn, chunkTop, ingested, 5);
    expect(out.map((c) => c.sessionId)).toEqual(["longmemeval-1", "longmemeval-2"]);
  });

  it("synthesizes a SearchResult from the turn hit when the wider net misses a turn-lane session", () => {
    const chunkTop = [chunk(1, 0.9)];
    const turn = [turnHit(99, 0.5, "synthesized text")];
    const widerNet = [chunk(1, 0.9)]; // session 99 has no chunks at all in wider net
    const out = appendUniqueByLane(chunkTop, turn, widerNet, ingested, 5);
    const sess99 = out.find((c) => c.sessionId === "longmemeval-99");
    expect(sess99).toBeDefined();
    expect(sess99!.text).toBe("synthesized text"); // fallback uses turn.row.content
  });
});

describe("rrfFuse (M2)", () => {
  it("RRF-fuses chunk-lane and turn-lane ranks and re-sorts", () => {
    // Chunk-lane ranks: 1→s1, 2→s2, 3→s3
    // Turn-lane ranks:  1→s3, 2→s4, 3→s1
    // RRF with rrfK=10:
    //   s1: 1/(10+1) + 1/(10+3) = 0.0909 + 0.0769 = 0.1678
    //   s2: 1/(10+2)             = 0.0833
    //   s3: 1/(10+3) + 1/(10+1) = 0.0769 + 0.0909 = 0.1678
    //   s4: 1/(10+2)             = 0.0833
    // Order: s1, s3 (tie — broken by chunk rank, so s1 first), then s2, s4 (tie — chunk first)
    const chunkTop = [chunk(1, 0.9), chunk(2, 0.8), chunk(3, 0.7)];
    const turn = [turnHit(3, 0), turnHit(4, 0), turnHit(1, 0)];
    const widerNet = [...chunkTop, chunk(4, 0.5)];
    const out = rrfFuse(chunkTop, turn, widerNet, ingested, 5, 10);
    const sessions = out.map((c) => c.sessionId);
    expect(sessions[0]).toBe("longmemeval-1"); // RRF top
    expect(sessions[1]).toBe("longmemeval-3"); // RRF tied, chunk-rank-3 breaks
    expect(sessions).toContain("longmemeval-4"); // appended via turn-lane
  });

  it("returns chunk-lane sorted by RRF when turn-lane is empty (degenerate)", () => {
    const chunkTop = [chunk(1, 0.9), chunk(2, 0.8)];
    const out = rrfFuse(chunkTop, [], chunkTop, ingested, 5, 60);
    expect(out.map((c) => c.sessionId)).toEqual(["longmemeval-1", "longmemeval-2"]);
  });

  it("caps output at 20 + maxAppend chunks", () => {
    const chunkTop = Array.from({ length: 20 }, (_, i) => chunk(i + 1, 1 - i * 0.01));
    const turn = Array.from({ length: 10 }, (_, i) => turnHit(100 + i, 0));
    const widerNet = [...chunkTop, ...Array.from({ length: 10 }, (_, i) => chunk(100 + i, 0.1))];
    const out = rrfFuse(chunkTop, turn, widerNet, ingested, 5, 60);
    expect(out.length).toBeLessThanOrEqual(25);
  });

  it("synthesizes a SearchResult when wider-net is missing a turn-lane session", () => {
    const chunkTop = [chunk(1, 0.9)];
    const turn = [turnHit(99, 0.5, "from turn")];
    const widerNet = [chunk(1, 0.9)];
    const out = rrfFuse(chunkTop, turn, widerNet, ingested, 5, 60);
    const sess99 = out.find((c) => c.sessionId === "longmemeval-99");
    expect(sess99).toBeDefined();
    expect(sess99!.text).toBe("from turn");
  });
});
