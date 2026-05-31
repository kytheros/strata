import { describe, it, expect } from "vitest";
import { pickStratified } from "../../benchmarks/longmemeval/stratified-set.js";

const DATASET = [
  ...Array.from({ length: 5 }, (_, i) => ({ question_id: `ie${i}`, question_type: "single-session-user" })),
  ...Array.from({ length: 5 }, (_, i) => ({ question_id: `ms${i}`, question_type: "multi-session" })),
  ...Array.from({ length: 5 }, (_, i) => ({ question_id: `tr${i}`, question_type: "temporal-reasoning" })),
  ...Array.from({ length: 5 }, (_, i) => ({ question_id: `ku${i}`, question_type: "knowledge-update" })),
  ...Array.from({ length: 5 }, (_, i) => ({ question_id: `ab${i}`, question_type: "unanswerable" })),
];

describe("pickStratified", () => {
  it("picks N per ability, deterministically (first N by id within each ability)", () => {
    const ids = pickStratified(DATASET as never, 3);
    // 5 abilities × 3 = 15
    expect(ids.length).toBe(15);
    // deterministic: sorted ids within each ability
    expect(ids).toContain("ie0"); expect(ids).toContain("ms2"); expect(ids).toContain("ab2");
    expect(ids).not.toContain("ie3");
  });

  it("caps at available count when an ability has fewer than N", () => {
    const small = DATASET.filter((q) => !q.question_id.startsWith("ab"))
      .concat([{ question_id: "ab0", question_type: "unanswerable" } as never]);
    const ids = pickStratified(small as never, 3);
    expect(ids.filter((x) => x.startsWith("ab")).length).toBe(1);
  });
});
