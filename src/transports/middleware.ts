/**
 * REST transport middleware helpers.
 *
 * checkTenantRateLimit — per-tenant sliding-window rate limiter.
 *
 * v1 implementation uses an in-memory Map keyed by `tenant:window`.
 * The interface is stable: a future Durable Object or Redis promotion
 * replaces the Map without changing call sites.
 */

export interface RateLimitOptions {
  /**
   * Shared counter store. In production, instantiate at server startup
   * (inside createServer / startRestTransport) — never at module scope
   * (D2 architectural constraint).
   */
  counters: Map<string, number>;
  /** Maximum requests allowed per window. */
  limit: number;
  /** Window size in seconds. */
  windowSec: number;
  /**
   * Returns the current time in fractional seconds.
   * Injected for deterministic testing; production callers pass
   * `() => Date.now() / 1000`.
   */
  now: () => number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Requests remaining in the current window (0 when blocked). */
  remaining: number;
}

/**
 * Check whether tenant is within their rate-limit window and increment the counter.
 *
 * Window key = `${tenant}:${Math.floor(now() / windowSec)}` — so each tenant
 * gets a fresh bucket every windowSec seconds. Old buckets are naturally
 * evicted by garbage collection as the window rolls forward; for
 * long-running single-process deployments you may want a periodic sweep,
 * but at 60 req/60 sec the Map stays small indefinitely.
 */
export async function checkTenantRateLimit(
  tenant: string,
  opts: RateLimitOptions
): Promise<RateLimitResult> {
  const window = Math.floor(opts.now() / opts.windowSec);
  const key = `${tenant}:${window}`;
  const used = opts.counters.get(key) ?? 0;

  if (used >= opts.limit) {
    return { allowed: false, remaining: 0 };
  }

  opts.counters.set(key, used + 1);
  return { allowed: true, remaining: opts.limit - used - 1 };
}
