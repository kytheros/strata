import { describe, it, expect, vi } from "vitest";
import { judgeGap, formatGapInjection, type GapVerdict } from "../../benchmarks/longmemeval/gap-judge.js";

describe("gap-judge", () => {
  it("returns sufficient when the model says so", async () => {
    const complete = vi.fn(async () => JSON.stringify({ sufficient: true, gaps: [] }));
    const v = await judgeGap("q?", "evidence", complete);
    expect(v.sufficient).toBe(true);
    expect(v.gaps).toEqual([]);
  });

  it("returns structured gaps when insufficient", async () => {
    const complete = vi.fn(async () =>
      JSON.stringify({ sufficient: false, gaps: [{ missing: "the date of purchase", suggestedQuery: "when bought laptop" }] }));
    const v = await judgeGap("q?", "evidence", complete);
    expect(v.sufficient).toBe(false);
    expect(v.gaps[0].missing).toMatch(/date of purchase/);
    expect(v.gaps[0].suggestedQuery).toBe("when bought laptop");
  });

  it("defensively defaults to sufficient=true on unparseable output (never blocks the loop)", async () => {
    const complete = vi.fn(async () => "garbage not json");
    const v = await judgeGap("q?", "evidence", complete);
    expect(v.sufficient).toBe(true);
  });

  it("formats gaps into an injection string the model can act on", () => {
    const v: GapVerdict = { sufficient: false, gaps: [{ missing: "X", suggestedQuery: "find X" }] };
    const s = formatGapInjection(v);
    expect(s).toMatch(/still missing/i);
    expect(s).toContain("X");
    expect(s).toContain("find X");
  });
});
