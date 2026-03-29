import { describe, it, expect } from "vitest";
import { getCodebook, quantizeScalar, dequantizeScalar } from "../../src/extensions/quantization/lloyd-max.js";

describe("Lloyd-Max codebook", () => {
  it("returns correct number of centroids for each bit-width", () => {
    expect(getCodebook(1).centroids.length).toBe(2);
    expect(getCodebook(2).centroids.length).toBe(4);
    expect(getCodebook(4).centroids.length).toBe(16);
    expect(getCodebook(8).centroids.length).toBe(256);
  });

  it("returns sorted centroids", () => {
    for (const bits of [1, 2, 4, 8] as const) {
      const { centroids } = getCodebook(bits);
      for (let i = 1; i < centroids.length; i++) {
        expect(centroids[i]).toBeGreaterThan(centroids[i - 1]);
      }
    }
  });

  it("returns boundaries with length = centroids - 1", () => {
    for (const bits of [1, 2, 4, 8] as const) {
      const cb = getCodebook(bits);
      expect(cb.boundaries.length).toBe(cb.centroids.length - 1);
    }
  });

  it("boundaries are midpoints between consecutive centroids", () => {
    const cb = getCodebook(4);
    for (let i = 0; i < cb.boundaries.length; i++) {
      const mid = (cb.centroids[i] + cb.centroids[i + 1]) / 2;
      expect(cb.boundaries[i]).toBeCloseTo(mid, 4);
    }
  });

  it("quantize then dequantize round-trips close to input", () => {
    const cb = getCodebook(4);
    // Test with values near the centroids
    for (const centroid of cb.centroids) {
      const idx = quantizeScalar(centroid, cb);
      const reconstructed = dequantizeScalar(idx, cb);
      expect(reconstructed).toBeCloseTo(centroid, 4);
    }
  });

  it("quantize maps extreme values to first/last centroid", () => {
    const cb = getCodebook(4);
    expect(quantizeScalar(-100, cb)).toBe(0);
    expect(quantizeScalar(100, cb)).toBe(cb.centroids.length - 1);
  });

  it("4-bit quantization error is small for Gaussian-like inputs", () => {
    const cb = getCodebook(4);
    // Codebook is built for padded d=4096, sigma = 1/sqrt(4096).
    // After Hadamard rotation, coordinates are approximately N(0, sigma).
    const sigma = 1 / Math.sqrt(4096);
    let totalError = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
      // Box-Muller for Gaussian samples
      const u1 = Math.random();
      const u2 = Math.random();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * sigma;
      const idx = quantizeScalar(z, cb);
      const recon = dequantizeScalar(idx, cb);
      totalError += (z - recon) ** 2;
    }
    const mse = totalError / N;
    // At 4-bit with 16 levels over the Gaussian range, MSE should be small
    // relative to sigma^2. Empirically ~0.15 * sigma^2 for Lloyd-Max.
    expect(mse).toBeLessThan(sigma * sigma * 0.25);
  });

  it("throws on unsupported bit-width", () => {
    expect(() => getCodebook(3 as never)).toThrow();
    expect(() => getCodebook(5 as never)).toThrow();
  });
});
