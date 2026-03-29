/**
 * Fast Walsh-Hadamard Transform (in-place, normalized).
 *
 * Applies the butterfly algorithm: O(n log n) for n-element vectors.
 * Input must be power-of-2 length. The transform is its own inverse
 * (up to a scaling factor of n), so we normalize by 1/sqrt(n).
 *
 * Reference: TurboQuant (Zandieh et al., 2025) — Section 3.1
 * The Hadamard rotation distributes coordinate magnitudes uniformly,
 * enabling near-optimal per-coordinate scalar quantization.
 */

/**
 * In-place Fast Walsh-Hadamard Transform (normalized by 1/sqrt(n)).
 * @param x - Float32Array of power-of-2 length
 * @throws if length is not a power of 2
 */
export function hadamardTransform(x: Float32Array): void {
  const n = x.length;
  if (n === 0 || (n & (n - 1)) !== 0) {
    throw new Error(`Hadamard transform requires power-of-2 length, got ${n}`);
  }

  // Butterfly passes
  for (let len = 1; len < n; len <<= 1) {
    for (let i = 0; i < n; i += len << 1) {
      for (let j = 0; j < len; j++) {
        const u = x[i + j];
        const v = x[i + j + len];
        x[i + j] = u + v;
        x[i + j + len] = u - v;
      }
    }
  }

  // Normalize by 1/sqrt(n) to preserve L2 norm
  const scale = 1 / Math.sqrt(n);
  for (let i = 0; i < n; i++) {
    x[i] *= scale;
  }
}

/**
 * Inverse Hadamard Transform. Since H is symmetric and orthogonal,
 * H^(-1) = H^T = H (up to normalization). Applying the same transform
 * twice with 1/sqrt(n) normalization each time gives identity.
 */
export function inverseHadamardTransform(x: Float32Array): void {
  hadamardTransform(x);
}

/**
 * Zero-pad a vector to the target length.
 * Returns the same array if already the correct size.
 */
export function zeroPad(x: Float32Array, targetLength: number): Float32Array {
  if (x.length === targetLength) return x;
  const padded = new Float32Array(targetLength);
  padded.set(x);
  return padded;
}

/**
 * Trim a padded vector back to the original length.
 */
export function trimPad(x: Float32Array, originalLength: number): Float32Array {
  if (x.length === originalLength) return x;
  return x.slice(0, originalLength);
}
