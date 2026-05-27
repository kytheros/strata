import { describe, it, expect } from "vitest";
import { applyOverrides } from "../../src/storage/dashboard-overrides.js";

describe("applyOverrides", () => {
  it("replaces a leaf value at the given dot path", () => {
    const base = { search: { defaultLimit: 20, maxLimit: 100 } };
    const out = applyOverrides(base, { "search.defaultLimit": 50 });
    expect(out.search.defaultLimit).toBe(50);
    expect(out.search.maxLimit).toBe(100);
  });

  it("walks into nested objects without mutating base", () => {
    const base = { health: { thresholds: { embedding_coverage: { ok: 0.95, warn: 0.7 } } } };
    const out = applyOverrides(base, { "health.thresholds.embedding_coverage.ok": 0.9 });
    expect(out.health.thresholds.embedding_coverage.ok).toBe(0.9);
    expect(out.health.thresholds.embedding_coverage.warn).toBe(0.7);
    // base untouched
    expect(base.health.thresholds.embedding_coverage.ok).toBe(0.95);
  });

  it("creates missing intermediate paths", () => {
    const base: Record<string, unknown> = {};
    const out = applyOverrides(base, { "a.b.c": 42 });
    expect((out as { a: { b: { c: number } } }).a.b.c).toBe(42);
  });

  it("replaces an entire subtree when the path lands on an object", () => {
    const base = { bm25: { k1: 1.2, b: 0.75 } };
    const out = applyOverrides(base, { "bm25": { k1: 1.5, b: 0.8 } });
    expect(out.bm25.k1).toBe(1.5);
    expect(out.bm25.b).toBe(0.8);
  });

  it("handles multiple overrides in one pass", () => {
    const base = { search: { defaultLimit: 20 }, gaps: { maxPerProject: 100 } };
    const out = applyOverrides(base, {
      "search.defaultLimit": 30,
      "gaps.maxPerProject": 200,
    });
    expect(out.search.defaultLimit).toBe(30);
    expect(out.gaps.maxPerProject).toBe(200);
  });
});
