// Playwright config for the Strata-on-AWS dev-stack E2E smoke suite.
//
// We are NOT driving a browser — every assertion goes through `request`
// fixtures (HTTP). This is intentional:
//   - The bugs we are catching live below the UI: DNS hostnames wrong, missing
//     SG ingress, missing env-var wiring, JWT-sub header injection, MCP
//     handshake bugs, SSE parse. Those reproduce with curl, so they should
//     reproduce with @playwright/test's `request` fixture too — no browser
//     needed, no Chromium download in CI, no flake from page rendering.
//   - The Cognito Hosted UI redirect is asserted as a `Location` header check
//     on a 307; we deliberately do not follow it. Browser-driven Hosted-UI
//     tests are valuable but slower and out of scope for this smoke suite.
//
// Runtime budget: < 90 s wall-clock for all 6 cases against the live stack.
// The /api/chat case dominates (Anthropic + tool-use loop ~30–60 s).

import { defineConfig } from "@playwright/test";

const BASE_URL =
  process.env.STRATA_DEV_URL ??
  "https://tk4ti92jwc.execute-api.us-east-1.amazonaws.com";

export default defineConfig({
  testDir: "./test/e2e",
  // Single worker keeps log output linear when debugging a failure against the
  // live stack. The suite is small (6 cases) and the long pole is /api/chat;
  // parallelism would not help wall-clock here.
  workers: 1,
  // Each case sets its own per-test timeout; this is the global ceiling.
  timeout: 120_000,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: BASE_URL,
    // Do not auto-follow redirects — case 3 asserts on the 307 Location.
    extraHTTPHeaders: {
      "User-Agent": "strata-aws-e2e-smoke/0.1",
    },
    // No retries against the live stack: a flake means a real wiring bug or a
    // real upstream outage; both are signals we want to investigate, not bury.
    trace: "retain-on-failure",
  },
  retries: 0,
  // No `webServer` block — we test the live stack, not a local dev server.
});
