/**
 * Lloyd-Max optimal scalar quantizers for Gaussian-distributed coordinates.
 *
 * After Hadamard rotation of a unit vector on S^(d-1), each coordinate
 * is approximately N(0, sigma^2) where sigma = 1/sqrt(paddedDim).
 * We compute optimal codebooks for the standard normal N(0,1) via
 * Lloyd-Max iteration, then scale centroids and boundaries by sigma
 * at query time.
 *
 * Reference: TurboQuant (Zandieh et al., 2025) -- Section 3, Lemma 1
 */

export type BitWidth = 1 | 2 | 4 | 8;

export interface Codebook {
  /** Bit-width this codebook was computed for */
  bitWidth: BitWidth;
  /** Sorted reconstruction centroids (length = 2^bitWidth) */
  centroids: Float64Array;
  /** Decision boundaries between consecutive centroids (length = 2^bitWidth - 1) */
  boundaries: Float64Array;
}

/** Standard normal PDF */
function phi(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Standard normal CDF (Abramowitz & Stegun 26.2.17).
 * Uses the complementary form: Q(x) = phi(x) * polynomial(t).
 * Maximum error < 7.5e-8.
 */
function normalCdf(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;

  // For negative x, use symmetry: Phi(-x) = 1 - Phi(x)
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.2316419 * ax);
  const d = 0.3989422804014327; // 1 / sqrt(2 * pi)
  const pdfVal = d * Math.exp(-0.5 * ax * ax);

  // Polynomial coefficients (A&S 26.2.17)
  const poly = pdfVal * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));

  return x >= 0 ? 1 - poly : poly;
}

/**
 * Conditional mean of N(0, 1) on interval (lo, hi).
 * E[X | lo < X < hi] = (phi(lo) - phi(hi)) / (Phi(hi) - Phi(lo))
 */
function stdNormalConditionalMean(lo: number, hi: number): number {
  const pdfLo = lo <= -8 ? 0 : phi(lo);
  const pdfHi = hi >= 8 ? 0 : phi(hi);
  const cdfLo = normalCdf(lo);
  const cdfHi = normalCdf(hi);
  const cdfDiff = cdfHi - cdfLo;

  if (cdfDiff < 1e-15) {
    // Fallback for near-zero probability intervals
    if (lo <= -8) return hi;
    if (hi >= 8) return lo;
    return (lo + hi) / 2;
  }

  return (pdfLo - pdfHi) / cdfDiff;
}

/**
 * Inverse standard normal CDF (quantile function).
 * Rational approximation from Abramowitz & Stegun (26.2.23).
 */
function normalQuantile(p: number): number {
  if (p <= 0) return -8;
  if (p >= 1) return 8;
  if (p === 0.5) return 0;

  const sign = p < 0.5 ? -1 : 1;
  const pp = p < 0.5 ? p : 1 - p;
  const t = Math.sqrt(-2 * Math.log(pp));
  const c0 = 2.515517, c1 = 0.802853, c2 = 0.010328;
  const d1 = 1.432788, d2 = 0.189269, d3 = 0.001308;
  return sign * (t - (c0 + c1 * t + c2 * t * t) / (1 + d1 * t + d2 * t * t + d3 * t * t * t));
}

/**
 * Compute Lloyd-Max centroids for the standard normal N(0, 1).
 *
 * Uses iterative Lloyd-Max:
 * 1. Initialize centroids uniformly over [-3, +3]
 * 2. Compute boundaries as midpoints between consecutive centroids
 * 3. Update centroids to conditional expectations E[X | b_{i-1} < X < b_i]
 * 4. Repeat until convergence
 */
function computeStdNormalLloydMax(
  numLevels: number,
  maxIter = 1000,
  tolerance = 1e-12
): { centroids: Float64Array; boundaries: Float64Array } {
  const centroids = new Float64Array(numLevels);
  const boundaries = new Float64Array(numLevels - 1);

  // Initialize centroids at conditional means of equal-probability bins.
  // Each bin has probability 1/numLevels under N(0,1).
  // This gives a near-optimal starting point and avoids tail collapse.
  for (let i = 0; i < numLevels; i++) {
    const lo = i === 0 ? -8 : normalQuantile(i / numLevels);
    const hi = i === numLevels - 1 ? 8 : normalQuantile((i + 1) / numLevels);
    centroids[i] = stdNormalConditionalMean(lo, hi);
  }

  for (let iter = 0; iter < maxIter; iter++) {
    // Update boundaries (midpoints between consecutive centroids)
    for (let i = 0; i < numLevels - 1; i++) {
      boundaries[i] = (centroids[i] + centroids[i + 1]) / 2;
    }

    // Update centroids to conditional expectation of N(0,1)
    let maxShift = 0;
    for (let i = 0; i < numLevels; i++) {
      const lo = i === 0 ? -Infinity : boundaries[i - 1];
      const hi = i === numLevels - 1 ? Infinity : boundaries[i];
      const newCentroid = stdNormalConditionalMean(lo, hi);
      maxShift = Math.max(maxShift, Math.abs(newCentroid - centroids[i]));
      centroids[i] = newCentroid;
    }

    if (maxShift < tolerance) break;
  }

  // Sort centroids to guarantee strict monotonicity
  centroids.sort();

  // Ensure strict monotonicity: nudge any equal-valued centroids apart
  const eps = 1e-12;
  for (let i = 1; i < numLevels; i++) {
    if (centroids[i] <= centroids[i - 1]) {
      centroids[i] = centroids[i - 1] + eps;
    }
  }

  // Final boundary update
  for (let i = 0; i < numLevels - 1; i++) {
    boundaries[i] = (centroids[i] + centroids[i + 1]) / 2;
  }

  return { centroids, boundaries };
}

// Standard deviation after Hadamard rotation of a unit vector zero-padded to 4096
const SIGMA = 1 / Math.sqrt(4096);

const codebooks = new Map<BitWidth, Codebook>();

function buildCodebook(bitWidth: BitWidth): Codebook {
  const numLevels = 1 << bitWidth;
  const { centroids: stdCentroids, boundaries: stdBoundaries } = computeStdNormalLloydMax(numLevels);

  // Scale from N(0,1) to N(0, sigma^2)
  const centroids = new Float64Array(numLevels);
  const boundaries = new Float64Array(numLevels - 1);
  for (let i = 0; i < numLevels; i++) {
    centroids[i] = stdCentroids[i] * SIGMA;
  }
  for (let i = 0; i < numLevels - 1; i++) {
    boundaries[i] = stdBoundaries[i] * SIGMA;
  }

  return { bitWidth, centroids, boundaries };
}

/**
 * Get the precomputed Lloyd-Max codebook for the given bit-width.
 * Codebooks are lazily computed and cached.
 */
export function getCodebook(bitWidth: BitWidth): Codebook {
  if (bitWidth !== 1 && bitWidth !== 2 && bitWidth !== 4 && bitWidth !== 8) {
    throw new Error(`Unsupported bit-width: ${bitWidth}. Must be 1, 2, 4, or 8.`);
  }
  let cb = codebooks.get(bitWidth);
  if (!cb) {
    cb = buildCodebook(bitWidth);
    codebooks.set(bitWidth, cb);
  }
  return cb;
}

/**
 * Quantize a single scalar value to its nearest centroid index.
 * Uses binary search on boundaries for O(log k) lookup.
 */
export function quantizeScalar(value: number, codebook: Codebook): number {
  const { boundaries } = codebook;
  let lo = 0;
  let hi = boundaries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (boundaries[mid] < value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Dequantize an index back to its centroid value.
 */
export function dequantizeScalar(index: number, codebook: Codebook): number {
  return codebook.centroids[index];
}
