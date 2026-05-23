import { describe, it, expect } from "vitest";
import { applyWithinSessionSpeakerPrefer, applyTurnRecencyBoost } from "../../src/search/result-ranker.js";
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
    // The within-session DESC correction for short-session correction patterns
    // is applied separately (query-gated) in applyTurnRecencyBoost, not here.
    // See applyShortSessionDescCorrection + SHORT_SESSION_USER_HIT_THRESHOLD.
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
    // Speaker-prefer groups users first in BM25 order; then assistants in
    // BM25 order. The DESC correction (fixing ranking-010) is applied
    // separately (query-gated) in applyTurnRecencyBoost.
    const hits = [
      hit("a", "s1", "user", 0, 0.9, "initial Redis proposal"),
      hit("b", "s1", "assistant", 1, 0.6, "Redis works"),
      hit("c", "s1", "user", 2, 0.5, "SQLite correction"),
      hit("d", "s1", "assistant", 3, 0.4, "SQLite makes more sense"),
      hit("e", "s1", "user", 4, 0.3, "SQLite confirmed"),
    ];
    const out = applyWithinSessionSpeakerPrefer(hits);
    // Users first in BM25 order (a=0.9, c=0.5, e=0.3), then assistants (b=0.6, d=0.4).
    // NOTE: DESC correction (ranking-010 fix) requires the query context and is
    // applied in applyTurnRecencyBoost, not here.
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

  it("applies turn-index DESC within user group when session has ≤3 user hits (short-session correction)", () => {
    // Mirrors ranking-006: 3-turn single-session correction pattern.
    // Two user turns (turn 0, turn 2) and one assistant turn (turn 1).
    // Query is NOT historical and NOT a duration question → DESC gate passes.
    // applyShortSessionDescCorrection fires (via applyTurnRecencyBoost):
    // 2 user hits ≤ 3 → DESC applied → correction turn surfaces at rank 1.
    const ts = 1700000000000;
    const hits = [
      hit("a", "s1", "user", 0, 0.9, "initial alpine", ts),
      hit("b", "s1", "assistant", 1, 0.6, "alpine confirm", ts + 1),
      hit("c", "s1", "user", 2, 0.5, "debian correction", ts + 2),
    ];
    // Query: not historical ("ago"/"previously"), not duration ("how many days passed")
    const query = "What base image are we using now?";
    const out = applyTurnRecencyBoost(hits, query, { force: true });
    // 2 user hits → DESC applies → user-2 (c) before user-0 (a); then assistant-1 (b).
    expect(out.map((h) => h.row.turnId)).toEqual(["c", "a", "b"]);
  });

  it("preserves BM25 order within user group when session has ≥4 user hits (LME exploratory)", () => {
    // Mirrors ranking-003/004/005: many user-turn hits in one session.
    // Six user turns and one assistant turn. DESC must NOT apply —
    // user-hit count (6) > SHORT_SESSION_USER_HIT_THRESHOLD (3).
    const ts = 1700000000000;
    const hits = [
      hit("a", "s1", "user", 0, 0.9, "expected query match", ts),
      hit("b", "s1", "user", 4, 0.8, "exploratory follow-up", ts + 4),
      hit("c", "s1", "user", 6, 0.7, "exploratory", ts + 6),
      hit("d", "s1", "user", 8, 0.6, "exploratory", ts + 8),
      hit("e", "s1", "user", 10, 0.5, "exploratory", ts + 10),
      hit("f", "s1", "user", 11, 0.4, "exploratory", ts + 11),
      hit("g", "s1", "assistant", 1, 0.3, "assistant reply", ts + 1),
    ];
    const query = "What are we using now?";
    const out = applyTurnRecencyBoost(hits, query, { force: true });
    // 6 user hits > 3 → DESC does NOT apply → BM25 order preserved within user
    // group; then assistant last.
    expect(out.map((h) => h.row.turnId)).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });

  it("applies DESC at the threshold boundary of exactly 3 user hits", () => {
    // Mirrors ranking-010: 5-turn single-session correction with 3 user hits.
    // Confirms the ≤ (not <) semantic of SHORT_SESSION_USER_HIT_THRESHOLD.
    // Query is NOT historical and NOT a duration question → DESC gate passes.
    const ts = 1700000000000;
    const hits = [
      hit("a", "s1", "user", 0, 0.9, "Redis initial", ts),
      hit("b", "s1", "assistant", 1, 0.7, "Redis confirm", ts + 1),
      hit("c", "s1", "user", 2, 0.5, "SQLite correction", ts + 2),
      hit("d", "s1", "assistant", 3, 0.4, "SQLite confirm", ts + 3),
      hit("e", "s1", "user", 4, 0.3, "SQLite confirmed", ts + 4),
    ];
    const query = "What is the storage layer for the rate limit bucket?";
    const out = applyTurnRecencyBoost(hits, query, { force: true });
    // 3 user hits → DESC applies (≤ threshold) → user-4, user-2, user-0;
    // then assistants in BM25 order: assistant-1 (0.7), assistant-3 (0.4).
    expect(out.map((h) => h.row.turnId)).toEqual(["e", "c", "a", "b", "d"]);
  });
});
