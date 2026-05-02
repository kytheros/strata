/**
 * Unit tests for fuseCommunityLanes — the Community-surface RRF fusion wrapper.
 *
 * Coverage:
 * - Basic fusion: two lists produce expected RRF-ranked output
 * - Score parity: produces byte-identical scores to fuseRecallLanes when
 *   inputs are equivalent (proves the wrapper doesn't drift the math)
 * - Single-lane passthrough (one empty list)
 * - Empty input (both lanes empty)
 * - Tie-breaking: stable insertion-order tiebreak
 * - Deduplication: same id in both lanes accumulates score once
 * - project + user_id are carried through to FusedResult
 * - opts.rrfK override changes scores correctly
 *
 * Spec: 2026-05-01-tirqdp-community-port-plan.md §TIRQDP-1.4
 * Ticket: TIRQDP-1.4
 */

import { describe, it, expect } from "vitest";
import {
  fuseCommunityLanes,
  type CommunityChunkResult,
  type FusedResult,
} from "../../src/search/recall-fusion-community.js";
import {
  fuseRecallLanes,
  type RecallCandidate,
} from "../../src/transports/recall-fusion.js";
import type { KnowledgeTurnHit } from "../../src/storage/interfaces/knowledge-turn-store.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeChunk(
  id: string,
  score: number,
  project = "proj-a",
  userId = "user-1",
  content = `chunk content ${id}`
): CommunityChunkResult {
  return { id, score, project, userId, content, tags: [] };
}

function makeTurnHit(
  turnId: string,
  score: number,
  project = "proj-a",
  userId = "user-1",
  content = `turn content ${turnId}`
): KnowledgeTurnHit {
  return {
    score,
    row: {
      turnId,
      sessionId: "sess-1",
      project,
      userId,
      speaker: "user",
      content,
      messageIndex: 0,
      createdAt: Date.now(),
    },
  };
}

/** Convert a CommunityChunkResult to a RecallCandidate for parity check. */
function chunkToCandidate(c: CommunityChunkResult): RecallCandidate {
  return {
    id: c.id,
    score: c.score,
    source: "fact",
    content: c.content,
    tags: c.tags,
    createdAt: 0,
    speaker: "player",
  };
}

/** Convert a KnowledgeTurnHit to a RecallCandidate for parity check. */
function hitToCandidate(h: KnowledgeTurnHit): RecallCandidate {
  return {
    id: h.row.turnId,
    score: h.score,
    source: "turn",
    content: h.row.content,
    tags: [],
    createdAt: h.row.createdAt,
    speaker: "player",
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("fuseCommunityLanes", () => {

  // ── basic fusion ────────────────────────────────────────────────────────────

  it("returns an empty array when both lanes are empty", () => {
    const result = fuseCommunityLanes([], [], {});
    expect(result).toEqual([]);
  });

  it("single chunk lane — returns all chunks with correct rrfScore", () => {
    const chunks = [makeChunk("c1", 0.9), makeChunk("c2", 0.5)];
    const result = fuseCommunityLanes(chunks, [], {});
    expect(result).toHaveLength(2);
    // With rrfK=40: rank-0 → 1/41, rank-1 → 1/42
    expect(result[0].rrfScore).toBeCloseTo(1 / 41, 10);
    expect(result[1].rrfScore).toBeCloseTo(1 / 42, 10);
    expect(result[0].id).toBe("c1");
    expect(result[1].id).toBe("c2");
  });

  it("single turn lane — returns all turns with correct rrfScore", () => {
    const turns = [makeTurnHit("t1", 0.8), makeTurnHit("t2", 0.4)];
    const result = fuseCommunityLanes([], turns, {});
    expect(result).toHaveLength(2);
    expect(result[0].rrfScore).toBeCloseTo(1 / 41, 10);
    expect(result[1].rrfScore).toBeCloseTo(1 / 42, 10);
    expect(result[0].id).toBe("t1");
    expect(result[1].id).toBe("t2");
  });

  it("fuses two lanes and ranks by accumulated RRF score", () => {
    // c1 appears rank-0 in chunks; t1 appears rank-0 in turns
    // t1 is only in turns at rank-0 → 1/41
    // c1 is only in chunks at rank-0 → 1/41
    // t2 is rank-1 in turns → 1/42
    const chunks = [makeChunk("c1", 0.9)];
    const turns = [makeTurnHit("t1", 0.8), makeTurnHit("t2", 0.3)];
    const result = fuseCommunityLanes(chunks, turns, {});
    expect(result).toHaveLength(3);
    // c1 and t1 both get 1/41 (tied); t2 gets 1/42
    expect(result[0].rrfScore).toBeCloseTo(1 / 41, 10);
    expect(result[1].rrfScore).toBeCloseTo(1 / 41, 10);
    expect(result[2].rrfScore).toBeCloseTo(1 / 42, 10);
    expect(result[2].id).toBe("t2");
  });

  it("same id in both lanes accumulates score (deduplication)", () => {
    // 'shared-id' appears at rank-0 in both → score = 1/41 + 1/41
    const chunks = [makeChunk("shared-id", 0.9)];
    const turns = [makeTurnHit("shared-id", 0.8)];
    const result = fuseCommunityLanes(chunks, turns, {});
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("shared-id");
    expect(result[0].rrfScore).toBeCloseTo(2 / 41, 10);
  });

  // ── project + user_id pass-through ──────────────────────────────────────────

  it("carries project and userId from chunk results through to FusedResult", () => {
    const chunks = [makeChunk("c1", 0.9, "my-project", "user-42")];
    const result = fuseCommunityLanes(chunks, [], {});
    expect(result[0].project).toBe("my-project");
    expect(result[0].userId).toBe("user-42");
  });

  it("carries project and userId from turn hits through to FusedResult", () => {
    const turns = [makeTurnHit("t1", 0.9, "turn-project", "user-99")];
    const result = fuseCommunityLanes([], turns, {});
    expect(result[0].project).toBe("turn-project");
    expect(result[0].userId).toBe("user-99");
  });

  // ── opts.rrfK override ──────────────────────────────────────────────────────

  it("opts.rrfK=60 changes the denominator", () => {
    const chunks = [makeChunk("c1", 0.9)];
    const result = fuseCommunityLanes(chunks, [], { rrfK: 60 });
    // With rrfK=60: rank-0 → 1/(60 + 0 + 1) = 1/61
    expect(result[0].rrfScore).toBeCloseTo(1 / 61, 10);
  });

  // ── FusedResult shape ───────────────────────────────────────────────────────

  it("FusedResult from a chunk includes content and tags fields", () => {
    const chunks = [makeChunk("c1", 0.9, "proj-x", "u-1", "chunk text here")];
    chunks[0].tags = ["lang:ts", "important"];
    const result = fuseCommunityLanes(chunks, [], {});
    expect(result[0].content).toBe("chunk text here");
    expect(result[0].tags).toEqual(["lang:ts", "important"]);
  });

  it("FusedResult from a turn hit includes content field", () => {
    const turns = [makeTurnHit("t1", 0.8, "proj-y", "u-2", "turn text here")];
    const result = fuseCommunityLanes([], turns, {});
    expect(result[0].content).toBe("turn text here");
  });

  // ── Math parity with fuseRecallLanes ────────────────────────────────────────

  it("produces byte-identical rrfScores to fuseRecallLanes for equivalent inputs (parity check)", () => {
    // This is the critical assertion: the wrapper must not drift the math.
    // We build equivalent inputs for both functions and compare every rrfScore.
    const chunks: CommunityChunkResult[] = [
      makeChunk("id-1", 0.95),
      makeChunk("id-2", 0.80),
      makeChunk("id-3", 0.60),
    ];
    const turns: KnowledgeTurnHit[] = [
      makeTurnHit("id-4", 0.90),
      makeTurnHit("id-2", 0.70), // id-2 appears in both lanes
      makeTurnHit("id-5", 0.55),
    ];

    // fuseCommunityLanes result
    const communityResult = fuseCommunityLanes(chunks, turns, {});

    // Equivalent fuseRecallLanes result (NPC function, same math)
    const npcResult = fuseRecallLanes([
      chunks.map(chunkToCandidate),
      turns.map(hitToCandidate),
    ]);

    // Both should have the same number of unique results
    expect(communityResult).toHaveLength(npcResult.length);

    // Build maps for score comparison by id
    const communityById = new Map(communityResult.map(r => [r.id, r.rrfScore]));
    const npcById = new Map(npcResult.map(r => [r.id, r.rrfScore]));

    for (const [id, communityScore] of communityById) {
      const npcScore = npcById.get(id);
      expect(npcScore).toBeDefined();
      // Byte-identical: same floating-point value
      expect(communityScore).toBe(npcScore);
    }
  });

  it("sorted output order matches fuseRecallLanes order for equivalent inputs", () => {
    const chunks: CommunityChunkResult[] = [
      makeChunk("id-1", 0.95),
      makeChunk("id-2", 0.80),
    ];
    const turns: KnowledgeTurnHit[] = [
      makeTurnHit("id-3", 0.90),
      makeTurnHit("id-2", 0.70), // id-2 in both
    ];

    const communityResult = fuseCommunityLanes(chunks, turns, {});
    const npcResult = fuseRecallLanes([
      chunks.map(chunkToCandidate),
      turns.map(hitToCandidate),
    ]);

    // Same ordering
    const communityIds = communityResult.map(r => r.id);
    const npcIds = npcResult.map(r => r.id);
    expect(communityIds).toEqual(npcIds);
  });

  // ── stable tiebreak ─────────────────────────────────────────────────────────

  it("ties are broken by insertion order (first occurrence wins)", () => {
    // Both c1 and t1 appear at rank-0 in their respective lanes → same score.
    // c1 is passed first (chunkResults is processed before turnResults)
    // so c1 should appear before t1.
    const chunks = [makeChunk("c1", 0.9)];
    const turns = [makeTurnHit("t1", 0.8)];
    const result = fuseCommunityLanes(chunks, turns, {});
    expect(result[0].id).toBe("c1");
    expect(result[1].id).toBe("t1");
  });

});
