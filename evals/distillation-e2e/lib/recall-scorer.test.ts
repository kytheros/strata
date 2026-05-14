import { describe, expect, test } from "vitest";
import { scoreRecall } from "./recall-scorer.js";

describe("recall-scorer (session-level matching, v1 — turn_index ignored)", () => {
  test("returns 1.0 when the expected session appears in top-K", () => {
    const result = scoreRecall(
      { expected: [{ session_id: "s1", turn_index: 0 }], min_recall_at_k: 1 },
      [
        { session_id: "s1", content: "", score: 0.9 },
        { session_id: "s2", content: "", score: 0.5 },
      ]
    );
    expect(result).toBe(1.0);
  });

  test("returns 0.0 when no expected session appears", () => {
    const result = scoreRecall(
      { expected: [{ session_id: "s1", turn_index: 0 }], min_recall_at_k: 1 },
      [{ session_id: "s2", content: "", score: 0.9 }]
    );
    expect(result).toBe(0.0);
  });

  test("requires at least min_recall_at_k expected sessions present", () => {
    // Expected sessions: s1, s2. Retrieved: only s1 → 1 hit, min=2 → fail.
    const result = scoreRecall(
      {
        expected: [
          { session_id: "s1", turn_index: 0 },
          { session_id: "s2", turn_index: 0 },
        ],
        min_recall_at_k: 2,
      },
      [{ session_id: "s1", content: "", score: 0.9 }]
    );
    expect(result).toBe(0.0);
  });

  test("passes when min_recall_at_k=2 and both expected sessions retrieved", () => {
    const result = scoreRecall(
      {
        expected: [
          { session_id: "s1", turn_index: 0 },
          { session_id: "s2", turn_index: 0 },
        ],
        min_recall_at_k: 2,
      },
      [
        { session_id: "s1", content: "", score: 0.9 },
        { session_id: "s2", content: "", score: 0.8 },
      ]
    );
    expect(result).toBe(1.0);
  });

  test("session-level: two expected items in same session count as 2 hits when that session retrieved", () => {
    // v1 LIMITATION (Option B follow-up): we cannot distinguish whether the
    // RIGHT turn within the session was retrieved. Both expected items
    // reference s1; if s1 is retrieved, both expected items "hit".
    const result = scoreRecall(
      {
        expected: [
          { session_id: "s1", turn_index: 0 },
          { session_id: "s1", turn_index: 5 },
        ],
        min_recall_at_k: 2,
      },
      [{ session_id: "s1", content: "", score: 0.9 }]
    );
    expect(result).toBe(1.0);
  });
});
