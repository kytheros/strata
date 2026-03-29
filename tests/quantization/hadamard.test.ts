import { describe, it, expect } from "vitest";
import { hadamardTransform, inverseHadamardTransform, zeroPad } from "../../src/extensions/quantization/hadamard.js";

describe("hadamardTransform", () => {
  it("transforms a simple 4-element vector", () => {
    const x = new Float32Array([1, 1, 1, 1]);
    hadamardTransform(x);
    // H_4 * [1,1,1,1] / sqrt(4) = [2, 0, 0, 0] (normalized)
    // With 1/sqrt(n) normalization: [1, 0, 0, 0] * 2 / sqrt(4) = [1, 0, 0, 0]
    // Unnormalized: [4, 0, 0, 0] / sqrt(4) = [2, 0, 0, 0]
    expect(x[0]).toBeCloseTo(2, 5);
    expect(x[1]).toBeCloseTo(0, 5);
    expect(x[2]).toBeCloseTo(0, 5);
    expect(x[3]).toBeCloseTo(0, 5);
  });

  it("is self-inverse (up to scaling)", () => {
    const original = new Float32Array([0.5, -0.3, 0.8, -0.1]);
    const copy = Float32Array.from(original);
    hadamardTransform(copy);
    inverseHadamardTransform(copy);
    for (let i = 0; i < original.length; i++) {
      expect(copy[i]).toBeCloseTo(original[i], 5);
    }
  });

  it("preserves L2 norm (Parseval's theorem)", () => {
    const x = new Float32Array([0.3, -0.7, 0.2, 0.9, -0.1, 0.5, -0.4, 0.6]);
    const normBefore = Math.sqrt(x.reduce((s, v) => s + v * v, 0));
    hadamardTransform(x);
    const normAfter = Math.sqrt(x.reduce((s, v) => s + v * v, 0));
    expect(normAfter).toBeCloseTo(normBefore, 4);
  });

  it("works on power-of-2 sizes up to 4096", () => {
    const x = new Float32Array(4096);
    for (let i = 0; i < 4096; i++) x[i] = Math.sin(i * 0.01);
    const normBefore = Math.sqrt(x.reduce((s, v) => s + v * v, 0));
    hadamardTransform(x);
    const normAfter = Math.sqrt(x.reduce((s, v) => s + v * v, 0));
    expect(normAfter).toBeCloseTo(normBefore, 2);
  });

  it("throws on non-power-of-2 input", () => {
    expect(() => hadamardTransform(new Float32Array(3))).toThrow();
    expect(() => hadamardTransform(new Float32Array(3072))).toThrow();
  });
});

describe("zeroPad", () => {
  it("pads 3072-dim vector to 4096", () => {
    const x = new Float32Array(3072).fill(1);
    const padded = zeroPad(x, 4096);
    expect(padded.length).toBe(4096);
    expect(padded[0]).toBe(1);
    expect(padded[3071]).toBe(1);
    expect(padded[3072]).toBe(0);
    expect(padded[4095]).toBe(0);
  });

  it("returns same array if already correct size", () => {
    const x = new Float32Array(4096);
    expect(zeroPad(x, 4096)).toBe(x);
  });
});
