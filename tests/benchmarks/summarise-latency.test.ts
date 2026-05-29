import { describe, it, expect } from "vitest";
import { summariseLatency } from "../../benchmarks/longmemeval/run-benchmark.js";

describe("summariseLatency", () => {
  it("returns all zeros for an empty input", () => {
    expect(summariseLatency([])).toEqual({
      meanMs: 0,
      p50LatencyMs: 0,
      p95LatencyMs: 0,
      p99LatencyMs: 0,
    });
  });

  it("computes mean + p50 + p95 + p99 from a sorted distribution", () => {
    // 100 values from 1..100
    const lats = Array.from({ length: 100 }, (_, i) => i + 1);
    const s = summariseLatency(lats);
    expect(s.meanMs).toBeCloseTo(50.5, 5);
    expect(s.p50LatencyMs).toBe(51); // floor(0.50 * 100) = 50 → index 50 → value 51
    expect(s.p95LatencyMs).toBe(96);
    expect(s.p99LatencyMs).toBe(100);
  });

  it("handles unsorted input (sorts internally) without mutating the caller's array", () => {
    const lats = [500, 100, 300, 200, 400];
    const copy = [...lats];
    const s = summariseLatency(lats);
    expect(lats).toEqual(copy); // unchanged
    expect(s.meanMs).toBe(300);
    expect(s.p50LatencyMs).toBe(300);
  });

  it("clamps the p99 to the max when only a single sample exists", () => {
    const s = summariseLatency([123]);
    expect(s.meanMs).toBe(123);
    expect(s.p50LatencyMs).toBe(123);
    expect(s.p95LatencyMs).toBe(123);
    expect(s.p99LatencyMs).toBe(123);
  });
});
