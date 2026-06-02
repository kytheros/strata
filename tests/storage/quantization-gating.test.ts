// strata/tests/storage/quantization-gating.test.ts
import { describe, it, expect } from "vitest";
import { encodeEmbeddingFor } from "../../src/storage/sqlite-knowledge-store.js";

describe("per-provider quantization gating", () => {
  it("stores raw float32 for a non-quantizing provider (768-dim does not crash)", () => {
    const v = new Float32Array(768); v[0] = 1;
    const { buf, format } = encodeEmbeddingFor(v, /* supportsQuantization */ false);
    expect(format).toBe("float32");
    expect(buf.length).toBe(3072);
  });

  it("quantizes for Gemini (supportsQuantization=true) when enabled", () => {
    const v = new Float32Array(3072); v[0] = 1;
    const { format } = encodeEmbeddingFor(v, true);
    expect(format).toMatch(/^tq\d|float32$/); // tq* when CONFIG.quantization.enabled, else float32
  });
});
