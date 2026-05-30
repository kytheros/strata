/**
 * Exponential-backoff retry for Vertex AI Gemini calls.
 *
 * gemini-2.5-flash on Vertex uses Dynamic Shared Quota (DSQ), not a per-project
 * adjustable quota. 429 RESOURCE_EXHAUSTED errors are transient regional
 * contention, not a fixed limit — Google docs say the documented mitigation
 * is application-level retry.
 *
 * Source: https://cloud.google.com/vertex-ai/generative-ai/docs/resources/dynamic-shared-quota
 */

export interface VertexBackoffOptions {
  /** Maximum retry attempts after the initial call. Default 7. */
  maxRetries?: number;
  /** Base delay in ms for the exponential backoff. Default 2000. */
  baseDelayMs?: number;
  /** Maximum single-attempt delay in ms (caps the exponential growth). Default 60000. */
  maxDelayMs?: number;
  /** Jitter fraction (±). Default 0.3 (±30%). */
  jitterFraction?: number;
  /** Optional logger; defaults to console.log. Used for retry diagnostics. */
  log?: (msg: string) => void;
  /** Sleep implementation, overridable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * True when the error matches a Vertex throttling signal:
 * - @google/genai SDK's `ApiError` carries `.status = 429`
 * - Some wrappers expose the same as `.code = 429`
 * - The serialized message often contains `"code":429` or `RESOURCE_EXHAUSTED`
 *
 * We accept any of these shapes so callers don't need to know which transport
 * surfaced the error.
 */
export function isVertexRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; code?: number | string; message?: string };
  if (e.status === 429) return true;
  if (e.code === 429 || e.code === "429") return true;
  const msg = String(e.message ?? err);
  if (/\b429\b/.test(msg) && /resource[\s_-]*exhausted/i.test(msg)) return true;
  if (/"code"\s*:\s*429/.test(msg)) return true;
  return false;
}

export function computeBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitterFraction: number,
  random: () => number = Math.random
): number {
  const exp = baseDelayMs * Math.pow(2, attempt);
  const capped = Math.min(exp, maxDelayMs);
  const jitter = capped * jitterFraction * (random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

/**
 * Run `fn` with exponential backoff on Vertex 429s. Any non-429 error is
 * re-thrown immediately. The final attempt's error is also re-thrown.
 */
export async function withVertexBackoff<T>(
  fn: () => Promise<T>,
  opts: VertexBackoffOptions = {}
): Promise<T> {
  const {
    maxRetries = 7,
    baseDelayMs = 2000,
    maxDelayMs = 60000,
    jitterFraction = 0.3,
    log = (msg) => console.log(msg),
    sleep = defaultSleep,
  } = opts;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isVertexRateLimitError(err) || attempt === maxRetries) {
        throw err;
      }
      const delay = computeBackoffDelay(
        attempt,
        baseDelayMs,
        maxDelayMs,
        jitterFraction
      );
      log(
        `  Vertex DSQ 429 (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms...`
      );
      await sleep(delay);
    }
  }
  throw new Error("withVertexBackoff: unreachable");
}
