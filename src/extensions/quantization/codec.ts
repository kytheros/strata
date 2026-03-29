/**
 * Binary codec for quantized vector BLOBs.
 *
 * Format:
 *   Byte 0: Version (0x01)
 *   Byte 1: Bit-width (1, 2, 4, or 8)
 *   Byte 2: Flags (0x00 = MSE-only, 0x01 = QJL — reserved)
 *   Byte 3: Checksum (XOR of all payload bytes)
 *   Byte 4+: Packed quantized indices
 *
 * Reference: specs/2026-03-29-turbo-quant-vector-quantization-design.md
 */

import type { BitWidth } from "./lloyd-max.js";

export const HEADER_VERSION = 0x01;
export const HEADER_SIZE = 4;

export interface BlobHeader {
  version: number;
  bitWidth: BitWidth;
  flags: number;
  checksum: number;
}

/**
 * Pack an array of quantization indices into a compact byte array.
 * At 4-bit, two indices fit per byte (high nibble first).
 */
export function packIndices(indices: Uint8Array, bitWidth: BitWidth): Uint8Array {
  const indicesPerByte = 8 / bitWidth;
  const byteCount = Math.ceil(indices.length / indicesPerByte);
  const packed = new Uint8Array(byteCount);

  if (bitWidth === 8) {
    packed.set(indices);
    return packed;
  }

  const mask = (1 << bitWidth) - 1;
  for (let i = 0; i < indices.length; i++) {
    const byteIdx = Math.floor(i / indicesPerByte);
    const bitOffset = (indicesPerByte - 1 - (i % indicesPerByte)) * bitWidth;
    packed[byteIdx] |= (indices[i] & mask) << bitOffset;
  }

  return packed;
}

/**
 * Unpack a compact byte array back into individual indices.
 */
export function unpackIndices(
  packed: Uint8Array,
  bitWidth: BitWidth,
  count: number
): Uint8Array {
  const indices = new Uint8Array(count);

  if (bitWidth === 8) {
    indices.set(packed.subarray(0, count));
    return indices;
  }

  const indicesPerByte = 8 / bitWidth;
  const mask = (1 << bitWidth) - 1;

  for (let i = 0; i < count; i++) {
    const byteIdx = Math.floor(i / indicesPerByte);
    const bitOffset = (indicesPerByte - 1 - (i % indicesPerByte)) * bitWidth;
    indices[i] = (packed[byteIdx] >>> bitOffset) & mask;
  }

  return indices;
}

/**
 * Encode the 4-byte BLOB header.
 */
export function encodeHeader(
  bitWidth: BitWidth,
  flags: number,
  payload: Uint8Array
): Uint8Array {
  const header = new Uint8Array(HEADER_SIZE);
  header[0] = HEADER_VERSION;
  header[1] = bitWidth;
  header[2] = flags;

  // XOR checksum of payload
  let checksum = 0;
  for (let i = 0; i < payload.length; i++) {
    checksum ^= payload[i];
  }
  header[3] = checksum & 0xff;

  return header;
}

/**
 * Decode and validate a BLOB header.
 */
export function decodeHeader(header: Uint8Array): BlobHeader {
  if (header.length < HEADER_SIZE) {
    throw new Error(`Header too short: ${header.length} bytes`);
  }
  return {
    version: header[0],
    bitWidth: header[1] as BitWidth,
    flags: header[2],
    checksum: header[3],
  };
}

/**
 * Combine header and payload into a single BLOB.
 */
export function encodeBlob(
  bitWidth: BitWidth,
  flags: number,
  payload: Uint8Array
): Uint8Array {
  const header = encodeHeader(bitWidth, flags, payload);
  const blob = new Uint8Array(HEADER_SIZE + payload.length);
  blob.set(header);
  blob.set(payload, HEADER_SIZE);
  return blob;
}

/**
 * Split a BLOB into header and payload.
 */
export function decodeBlob(blob: Uint8Array): { header: BlobHeader; payload: Uint8Array } {
  const header = decodeHeader(blob);
  const payload = blob.subarray(HEADER_SIZE);
  return { header, payload };
}

/**
 * Calculate expected BLOB size for a given dimension and bit-width.
 */
export function expectedBlobSize(paddedDim: number, bitWidth: BitWidth): number {
  const payloadBytes = Math.ceil((paddedDim * bitWidth) / 8);
  return HEADER_SIZE + payloadBytes;
}
