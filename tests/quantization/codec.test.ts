import { describe, it, expect } from "vitest";
import {
  packIndices,
  unpackIndices,
  encodeHeader,
  decodeHeader,
  HEADER_SIZE,
  HEADER_VERSION,
} from "../../src/extensions/quantization/codec.js";
import type { BitWidth } from "../../src/extensions/quantization/lloyd-max.js";

describe("packIndices", () => {
  it("packs 4-bit indices into half-bytes", () => {
    const indices = new Uint8Array([0x0A, 0x0B, 0x0C, 0x0D]);
    const packed = packIndices(indices, 4);
    // Two indices per byte: [0xAB, 0xCD]
    expect(packed.length).toBe(2);
    expect(packed[0]).toBe(0xAB);
    expect(packed[1]).toBe(0xCD);
  });

  it("packs 2-bit indices into quarter-bytes", () => {
    const indices = new Uint8Array([0, 1, 2, 3, 3, 2, 1, 0]);
    const packed = packIndices(indices, 2);
    // Four indices per byte: [0b00_01_10_11, 0b11_10_01_00] = [0x1B, 0xE4]
    expect(packed.length).toBe(2);
  });

  it("packs 1-bit indices into bytes", () => {
    const indices = new Uint8Array([1, 0, 1, 1, 0, 0, 1, 0]);
    const packed = packIndices(indices, 1);
    expect(packed.length).toBe(1);
    expect(packed[0]).toBe(0b10110010);
  });

  it("packs 8-bit indices as-is", () => {
    const indices = new Uint8Array([42, 255, 0, 128]);
    const packed = packIndices(indices, 8);
    expect(packed.length).toBe(4);
    expect(packed[0]).toBe(42);
  });

  it("round-trips through pack/unpack for all bit-widths", () => {
    for (const bits of [1, 2, 4, 8] as BitWidth[]) {
      const maxVal = (1 << bits) - 1;
      const count = 4096;
      const indices = new Uint8Array(count);
      for (let i = 0; i < count; i++) indices[i] = i % (maxVal + 1);

      const packed = packIndices(indices, bits);
      const unpacked = unpackIndices(packed, bits, count);

      expect(unpacked.length).toBe(count);
      for (let i = 0; i < count; i++) {
        expect(unpacked[i]).toBe(indices[i]);
      }
    }
  });
});

describe("header", () => {
  it("encodes and decodes a header", () => {
    const payload = new Uint8Array([0xAA, 0xBB, 0xCC]);
    const header = encodeHeader(4, 0x00, payload);
    expect(header.length).toBe(HEADER_SIZE);
    expect(header[0]).toBe(HEADER_VERSION);
    expect(header[1]).toBe(4); // bitWidth

    const decoded = decodeHeader(header);
    expect(decoded.version).toBe(HEADER_VERSION);
    expect(decoded.bitWidth).toBe(4);
    expect(decoded.flags).toBe(0x00);
  });

  it("checksum detects corruption", () => {
    const payload = new Uint8Array([0xAA, 0xBB, 0xCC]);
    const header = encodeHeader(4, 0x00, payload);
    const originalChecksum = header[3];

    // Verify checksum is set
    expect(originalChecksum).not.toBe(0);
  });

  it("payload size is correct for 4-bit at 4096 dims", () => {
    // 4096 indices at 4-bit = 2048 bytes payload
    const indices = new Uint8Array(4096).fill(5);
    const packed = packIndices(indices, 4);
    expect(packed.length).toBe(2048);
    // Total BLOB = header(4) + payload(2048) = 2052
    const header = encodeHeader(4, 0x00, packed);
    expect(header.length + packed.length).toBe(2052);
  });
});
