/**
 * TurboQuant MSE orchestrator: quantize and dequantize 3072-dim embeddings.
 *
 * Pipeline:
 *   Encode: zeroPad(3072->4096) -> Hadamard -> Lloyd-Max scalar quantize -> pack -> header+payload
 *   Decode: header+payload -> unpack -> Lloyd-Max dequantize -> inverse Hadamard -> trim(4096->3072)
 *
 * Reference: TurboQuant (Zandieh et al., 2025) -- Algorithm 1
 */

import { CONFIG } from "../../config.js";
import { hadamardTransform, inverseHadamardTransform, zeroPad, trimPad } from "./hadamard.js";
import { getCodebook, quantizeScalar, dequantizeScalar, type BitWidth } from "./lloyd-max.js";
import { packIndices, unpackIndices, encodeBlob, decodeBlob, HEADER_VERSION } from "./codec.js";

const FLOAT32_BLOB_SIZE = CONFIG.quantization.embeddingDim * 4; // 12288

/**
 * Quantize a Float32Array embedding to a compact binary BLOB.
 *
 * @param vec - Raw 3072-dim Float32Array from Gemini
 * @param bitWidth - Quantization precision (1, 2, 4, or 8)
 * @returns Uint8Array BLOB with header + packed indices
 */
export function quantize(vec: Float32Array, bitWidth: BitWidth = 4): Uint8Array {
  const paddedDim = CONFIG.quantization.paddedDim;
  const embeddingDim = CONFIG.quantization.embeddingDim;

  if (vec.length !== embeddingDim) {
    throw new Error(`Expected ${embeddingDim}-dim vector, got ${vec.length}`);
  }

  // 1. Zero-pad to power-of-2
  const padded = zeroPad(vec, paddedDim);

  // 2. Hadamard rotation (in-place)
  hadamardTransform(padded);

  // 3. Per-coordinate Lloyd-Max quantization
  const codebook = getCodebook(bitWidth);
  const indices = new Uint8Array(paddedDim);
  for (let i = 0; i < paddedDim; i++) {
    indices[i] = quantizeScalar(padded[i], codebook);
  }

  // 4. Pack indices and prepend header
  const payload = packIndices(indices, bitWidth);
  return encodeBlob(bitWidth, 0x00, payload);
}

/**
 * Dequantize a BLOB back to a Float32Array embedding.
 *
 * @param blob - Quantized BLOB (Uint8Array or Buffer)
 * @returns Reconstructed 3072-dim Float32Array
 */
export function dequantize(blob: Uint8Array | Buffer): Float32Array {
  const paddedDim = CONFIG.quantization.paddedDim;
  const embeddingDim = CONFIG.quantization.embeddingDim;

  // Handle Buffer -> Uint8Array
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);

  // 1. Decode header and payload
  const { header, payload } = decodeBlob(bytes);

  if (header.version !== HEADER_VERSION) {
    throw new Error(`Unsupported quantization version: ${header.version}`);
  }

  // 2. Unpack indices
  const indices = unpackIndices(payload, header.bitWidth, paddedDim);

  // 3. Look up centroids
  const codebook = getCodebook(header.bitWidth);
  const reconstructed = new Float32Array(paddedDim);
  for (let i = 0; i < paddedDim; i++) {
    reconstructed[i] = dequantizeScalar(indices[i], codebook);
  }

  // 4. Inverse Hadamard rotation
  inverseHadamardTransform(reconstructed);

  // 5. Trim back to original dimension
  return trimPad(reconstructed, embeddingDim);
}

/**
 * Detect whether a BLOB is quantized (vs raw Float32).
 * Uses BLOB size as primary discriminator:
 * - Float32 BLOBs for 3072 dims are always exactly 12,288 bytes
 * - Quantized BLOBs are always smaller (2,052 at 4-bit, etc.)
 */
export function isQuantizedBlob(blob: Buffer | Uint8Array): boolean {
  return blob.length !== FLOAT32_BLOB_SIZE;
}

/**
 * Transparently dequantize a BLOB if needed, or interpret as raw Float32.
 * This is the read-path function that handles both formats.
 */
export function blobToFloat32(blob: Buffer): Float32Array {
  if (blob.length === FLOAT32_BLOB_SIZE) {
    // Raw Float32 -- deserialize directly
    return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  }
  // Quantized -- dequantize
  return dequantize(blob);
}
