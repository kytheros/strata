import { describe, it, expect } from "vitest";
import { quantize, dequantize, isQuantizedBlob } from "../../src/extensions/quantization/turbo-quant.js";
import { expectedBlobSize, HEADER_SIZE } from "../../src/extensions/quantization/codec.js";

describe("TurboQuant", () => {
  it("quantizes a 3072-dim vector to expected blob size at 4-bit", () => {
    const vec = new Float32Array(3072);
    for (let i = 0; i < 3072; i++) vec[i] = Math.sin(i * 0.01) * 0.1;
    // Normalize to unit vector
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    for (let i = 0; i < 3072; i++) vec[i] /= norm;

    const blob = quantize(vec, 4);
    expect(blob.length).toBe(expectedBlobSize(4096, 4)); // 2052
  });

  it("round-trip preserves vector approximately at 4-bit", () => {
    // Use a deterministic pseudo-random unit vector via a simple LCG.
    // Real embeddings from neural nets have near-uniform energy spread
    // across dimensions, similar to random vectors.
    const vec = new Float32Array(3072);
    let seed = 42;
    for (let i = 0; i < 3072; i++) {
      seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
      vec[i] = seed / 0x7fffffff - 0.5;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    for (let i = 0; i < 3072; i++) vec[i] /= norm;

    const blob = quantize(vec, 4);
    const reconstructed = dequantize(blob);

    expect(reconstructed.length).toBe(3072);

    // Cosine similarity between original and reconstructed should be high
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < 3072; i++) {
      dot += vec[i] * reconstructed[i];
      magA += vec[i] * vec[i];
      magB += reconstructed[i] * reconstructed[i];
    }
    const cosine = dot / (Math.sqrt(magA) * Math.sqrt(magB));
    expect(cosine).toBeGreaterThan(0.99); // 4-bit should be very close
  });

  it("quantizes at different bit-widths", () => {
    const vec = new Float32Array(3072);
    for (let i = 0; i < 3072; i++) vec[i] = (i - 1536) / 3072;
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    for (let i = 0; i < 3072; i++) vec[i] /= norm;

    for (const bits of [1, 2, 4, 8] as const) {
      const blob = quantize(vec, bits);
      expect(blob.length).toBe(expectedBlobSize(4096, bits));

      const recon = dequantize(blob);
      expect(recon.length).toBe(3072);
    }
  });

  it("higher bit-width gives better reconstruction", () => {
    const vec = new Float32Array(3072);
    for (let i = 0; i < 3072; i++) vec[i] = Math.random() - 0.5;
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    for (let i = 0; i < 3072; i++) vec[i] /= norm;

    const errors: number[] = [];
    for (const bits of [1, 2, 4, 8] as const) {
      const recon = dequantize(quantize(vec, bits));
      let mse = 0;
      for (let i = 0; i < 3072; i++) mse += (vec[i] - recon[i]) ** 2;
      errors.push(mse / 3072);
    }

    // Each higher bit-width should have lower error
    for (let i = 1; i < errors.length; i++) {
      expect(errors[i]).toBeLessThan(errors[i - 1]);
    }
  });

  it("isQuantizedBlob detects quantized vs Float32 blobs", () => {
    const vec = new Float32Array(3072);
    for (let i = 0; i < 3072; i++) vec[i] = 0.01;

    // Quantized blob
    const blob = quantize(vec, 4);
    expect(isQuantizedBlob(Buffer.from(blob))).toBe(true);

    // Raw Float32 blob (12288 bytes)
    const rawBuf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    expect(isQuantizedBlob(rawBuf)).toBe(false);
  });
});
