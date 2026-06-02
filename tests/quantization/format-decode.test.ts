// strata/tests/quantization/format-decode.test.ts
import { describe, it, expect } from "vitest";
import { blobToFloat32 } from "../../src/extensions/quantization/turbo-quant.js";

describe("blobToFloat32 format-aware decode", () => {
  it("decodes a 768-dim raw float32 blob as raw when format='float32'", () => {
    const v = new Float32Array(768); v[0] = 1;
    const blob = Buffer.from(v.buffer, v.byteOffset, v.byteLength); // 3072 bytes
    const out = blobToFloat32(blob, "float32");
    expect(out.length).toBe(768);
    expect(out[0]).toBeCloseTo(1, 5);
  });

  it("treats absent format (legacy 12288-byte blob) as Gemini raw float32", () => {
    const v = new Float32Array(3072); v[1] = 1;
    const blob = Buffer.from(v.buffer, v.byteOffset, v.byteLength); // 12288 bytes
    const out = blobToFloat32(blob, undefined);
    expect(out.length).toBe(3072);
    expect(out[1]).toBeCloseTo(1, 5);
  });
});
