/**
 * Vitest global setup — runs once before any test file loads.
 *
 * Sets deterministic environment defaults so transports and auth flows
 * can be instantiated without real production secrets. Keep this file
 * small: it runs for every test run and should not import runtime code.
 */

// startRestTransport() refuses to start if STRATA_TOKEN_SECRET is unset.
// Tests use a deterministic secret so generated tokens are reproducible.
if (!process.env.STRATA_TOKEN_SECRET) {
  process.env.STRATA_TOKEN_SECRET = "test-token-secret-for-vitest-only";
}
