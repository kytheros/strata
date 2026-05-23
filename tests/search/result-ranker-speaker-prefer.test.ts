import { describe, it, expect } from "vitest";
import { applyWithinSessionSpeakerPrefer } from "../../src/search/result-ranker.js";
import type { KnowledgeTurnHit } from "../../src/storage/interfaces/knowledge-turn-store.js";

function hit(
  turnId: string,
  sessionId: string,
  speaker: "user" | "assistant" | "system",
  messageIndex: number,
  score: number,
  content = "",
  createdAt = 1000,
): KnowledgeTurnHit {
  return {
    row: { turnId, sessionId, project: null, userId: null, speaker, content, messageIndex, createdAt },
    score,
  };
}

describe("applyWithinSessionSpeakerPrefer", () => {
  it("returns empty input unchanged", () => {
    expect(applyWithinSessionSpeakerPrefer([])).toEqual([]);
  });

  it("returns single hit unchanged", () => {
    const single = [hit("a", "s1", "user", 0, 0.5)];
    expect(applyWithinSessionSpeakerPrefer(single)).toEqual(single);
  });

  it("within a session, user turns precede assistant turns", () => {
    // BM25 order had assistant ahead; speaker-prefer flips it.
    const hits = [
      hit("a", "s1", "assistant", 1, 0.8, "assistant echo"),
      hit("b", "s1", "user", 0, 0.5, "user decision"),
    ];
    const out = applyWithinSessionSpeakerPrefer(hits);
    expect(out.map((h) => h.row.turnId)).toEqual(["b", "a"]);
    expect(out[0].score).toBe(0.5); // scores unchanged
    expect(out[1].score).toBe(0.8);
  });

  it("within same speaker, BM25 (input) order is preserved", () => {
    // Two user turns. Speaker-prefer does NOT apply a turn-index tiebreaker
    // within the same speaker — BM25 order is preserved. Turn 0 has higher
    // BM25 (0.8) and stays first.
    //
    // Background: a DESC turn-index tiebreaker was tried but regressed LME
    // fixtures 003/004/005 where the expected answer is at the earliest user
    // turn in a long multi-turn session. See design §analysis-2026-05-23.
    const hits = [
      hit("a", "s1", "user", 0, 0.8, "initial"),
      hit("b", "s1", "user", 2, 0.5, "correction"),
    ];
    const out = applyWithinSessionSpeakerPrefer(hits);
    // BM25 order preserved within same speaker: a (score 0.8) before b (score 0.5).
    expect(out.map((h) => h.row.turnId)).toEqual(["a", "b"]);
  });

  it("preserves cross-session order (does not undo session-level ordering)", () => {
    // s2 appears first in input; s1 second. After speaker-prefer, sessions
    // stay in that order; only within-session order changes.
    const hits = [
      hit("a", "s2", "assistant", 1, 0.9, "s2 assistant"),
      hit("b", "s2", "user", 0, 0.4, "s2 user"),
      hit("c", "s1", "assistant", 1, 0.7, "s1 assistant"),
      hit("d", "s1", "user", 0, 0.3, "s1 user"),
    ];
    const out = applyWithinSessionSpeakerPrefer(hits);
    expect(out.map((h) => h.row.turnId)).toEqual(["b", "a", "d", "c"]);
  });

  it("system speaker sorts last (after assistant)", () => {
    const hits = [
      hit("a", "s1", "system", 2, 0.9),
      hit("b", "s1", "assistant", 1, 0.8),
      hit("c", "s1", "user", 0, 0.7),
    ];
    const out = applyWithinSessionSpeakerPrefer(hits);
    expect(out.map((h) => h.row.turnId)).toEqual(["c", "b", "a"]);
  });

  it("handles multi-session multi-speaker correctly (combined)", () => {
    // 5-turn correction pattern (mirrors ranking-010 fixture).
    const hits = [
      hit("a", "s1", "user", 0, 0.9, "initial Redis proposal"),
      hit("b", "s1", "assistant", 1, 0.6, "Redis works"),
      hit("c", "s1", "user", 2, 0.5, "SQLite correction"),
      hit("d", "s1", "assistant", 3, 0.4, "SQLite makes more sense"),
      hit("e", "s1", "user", 4, 0.3, "SQLite confirmed"),
    ];
    const out = applyWithinSessionSpeakerPrefer(hits);
    // Users first in BM25 order (a=0.9, c=0.5, e=0.3), then assistants (b=0.6, d=0.4).
    // NOTE: This does NOT fix ranking-010 (SQLite correction needs turn-index DESC,
    // which regresses LME fixtures). Fixing ranking-010 requires a separate approach.
    expect(out.map((h) => h.row.turnId)).toEqual(["a", "c", "e", "b", "d"]);
  });

  it("is stable for hits with identical (speaker, messageIndex) — preserves input order", () => {
    // This case can't happen in production (messageIndex unique per session),
    // but the comparator must be deterministic. Force the case by reusing
    // sessionId + messageIndex; rely on stable sort to preserve input order.
    const hits = [
      hit("a", "s1", "user", 0, 0.5, "first user-0"),
      hit("b", "s1", "user", 0, 0.4, "second user-0"),
    ];
    const out = applyWithinSessionSpeakerPrefer(hits);
    expect(out.map((h) => h.row.turnId)).toEqual(["a", "b"]);
  });
});
