// Strata-on-AWS dev-stack E2E smoke suite.
//
// Catches the cross-cutting wiring bugs that no unit test reaches — DNS,
// Security Group ingress, env-var wiring, Cognito redirect URL composition,
// JWT-sub header injection, MCP `initialize` handshake, SSE framing, and the
// /api/chat tool-loop. If this suite is green, the dev stack is exercising
// every external boundary the way a real Claude-Code-on-MCP user would.
//
// Run: STRATA_DEV_URL=https://... npx playwright test --grep @smoke
//
// Order of cases mirrors the dependency chain: cheapest checks first
// (anonymous HTTP shape) → auth shape → MCP-with-token → /api/chat (slow,
// dependent on Anthropic). A failure in case N tells the operator exactly
// which layer broke.

import { test, expect, type APIResponse } from "@playwright/test";
import { loadSessionCookie } from "./helpers/cookie.js";
import { mintTestUserAccessToken } from "./helpers/cognito-token.js";

// ---------------------------------------------------------------------------
// Case 1 — /health: cheapest possible reachability check.
// Catches: DNS misconfiguration, ingress -> Strata SG ingress missing,
// API GW route registration drift.
// ---------------------------------------------------------------------------
test("@smoke GET /health returns 200 with status:ok", async ({ request }) => {
  const res = await request.get("/health", { timeout: 15_000 });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ status: "ok" });
});

// ---------------------------------------------------------------------------
// Case 2 — anonymous GET / serves the example-agent landing page.
// Catches: container not starting (missing env var), ingress wired to wrong
// target group, ECS service unhealthy.
// ---------------------------------------------------------------------------
test("@smoke GET / (anonymous) renders the AWS Concierge landing page", async ({ request }) => {
  const res = await request.get("/", { timeout: 15_000 });
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain("AWS Concierge");
});

// ---------------------------------------------------------------------------
// Case 3 — /api/auth/login redirects to the Cognito Hosted UI with a
// well-formed authorize URL. Catches the entire class of bugs where the
// container env was not wired up (missing COGNITO_*, missing app_url):
//   - 307 (not 302/500) confirms Next.js redirect responded
//   - Location host = the Cognito Hosted UI domain (DNS check)
//   - client_id, redirect_uri, state present (env-var injection check)
// ---------------------------------------------------------------------------
test("@smoke GET /api/auth/login redirects to Cognito Hosted UI with required OAuth params", async ({
  request,
}) => {
  const res = await request.get("/api/auth/login", {
    maxRedirects: 0,
    timeout: 15_000,
  });
  expect(res.status()).toBe(307);
  const location = res.headers()["location"];
  expect(location, "Location header missing on /api/auth/login").toBeTruthy();
  expect(location).toMatch(
    /^https:\/\/strata-dev-624990353897\.auth\.us-east-1\.amazoncognito\.com\/oauth2\/authorize\?/,
  );
  // OAuth state is non-deterministic; we only check it's present + non-empty.
  const url = new URL(location);
  const params = url.searchParams;
  expect(params.get("client_id")).toMatch(/.+/);
  expect(params.get("redirect_uri")).toMatch(/^https:\/\/.+\/api\/auth\/callback$/);
  expect(params.get("state")).toMatch(/.+/);
});

// ---------------------------------------------------------------------------
// Case 4 — POST /mcp without Authorization is rejected by the API GW JWT
// authorizer. Catches: authorizer detached, route mis-bound to the public
// $default integration, accidentally permissive auth scheme.
// API GW returns 401 with body `{"message":"Unauthorized"}` when the
// authorizer rejects.
// ---------------------------------------------------------------------------
test("@smoke POST /mcp without Authorization returns 401", async ({ request }) => {
  const res = await request.post("/mcp", {
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    data: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    timeout: 15_000,
  });
  expect(res.status()).toBe(401);
});

// ---------------------------------------------------------------------------
// Case 5 — full MCP handshake with a freshly-minted Cognito token:
//   a. POST /mcp `initialize` → 200, Content-Type text/event-stream,
//      body parses as JSON-RPC with result.protocolVersion, captures
//      mcp-session-id header.
//   b. POST /mcp `tools/list` (with session id) → result.tools length ≥ 10.
//
// Catches: missing X-Strata-Verified injection (Strata would 403),
// JWT additional_audiences not wired (authorizer rejects test-user token),
// SSE framing regression, MCP session-id header dropped by API GW or
// the integration mapping.
// ---------------------------------------------------------------------------
test("@smoke POST /mcp initialize + tools/list returns ≥10 tools over SSE", async ({ request }) => {
  test.setTimeout(60_000); // token mint + 2 round-trips can run ~10 s cold.

  const token = await mintTestUserAccessToken();

  // ---- initialize -------------------------------------------------------
  const initRes = await request.post("/mcp", {
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "strata-aws-e2e-smoke", version: "0.1.0" },
      },
    },
    timeout: 30_000,
  });
  expect(initRes.status(), await safeBody(initRes)).toBe(200);

  const contentType = initRes.headers()["content-type"] ?? "";
  expect(contentType).toContain("text/event-stream");

  const sessionId = initRes.headers()["mcp-session-id"];
  expect(sessionId, "mcp-session-id missing on initialize response").toBeTruthy();

  const initBody = await initRes.text();
  const initJson = parseSseJsonRpc(initBody);
  expect(initJson.result?.protocolVersion).toMatch(/.+/);

  // ---- tools/list -------------------------------------------------------
  const listRes = await request.post("/mcp", {
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "mcp-session-id": sessionId!,
    },
    data: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    timeout: 30_000,
  });
  expect(listRes.status(), await safeBody(listRes)).toBe(200);

  const listJson = parseSseJsonRpc(await listRes.text());
  expect(Array.isArray(listJson.result?.tools)).toBe(true);
  expect((listJson.result?.tools as unknown[]).length).toBeGreaterThanOrEqual(10);
});

// ---------------------------------------------------------------------------
// Case 6 — POST /api/chat with the cookie drives the full Anthropic + tool
// loop. Slow (30–90 s) and depends on Claude availability, but it is the
// only end-to-end check that the agent's MCP-client wiring (env vars +
// network reachability + JWT-sub injection on outbound calls) all work
// together. If unit tests pass and this fails, the bug is in the cross-cut.
// ---------------------------------------------------------------------------
test("@smoke POST /api/chat with valid cookie returns a non-empty assistant message", async ({
  request,
}) => {
  test.setTimeout(120_000);

  const cookie = loadSessionCookie();

  const res = await request.post("/api/chat", {
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie.header,
    },
    data: { message: "say hi" },
    timeout: 90_000,
  });

  expect(res.status(), await safeBody(res)).toBe(200);
  const body = await res.json();

  expect(typeof body.message).toBe("string");
  expect(body.message.length).toBeGreaterThan(0);
  expect(Array.isArray(body.toolCalls)).toBe(true);
  // Anthropic returns a small set of valid stop reasons; any of them is fine,
  // we just want to confirm the loop terminated cleanly rather than 500'd.
  expect(typeof body.stoppedReason).toBe("string");
  expect([
    "end_turn",
    "max_tokens",
    "stop_sequence",
    "tool_use",
    "pause_turn",
  ]).toContain(body.stoppedReason);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse an MCP Streamable HTTP response body. The transport may return either
 * pure JSON or `text/event-stream` framed as `event: message\ndata: {...}\n\n`.
 * We pick the first `data:` line and JSON.parse it. Mirrors the canary
 * Lambda's parse logic.
 */
function parseSseJsonRpc(text: string): {
  result?: { protocolVersion?: string; tools?: unknown[] };
  error?: unknown;
} {
  const trimmed = text.trim();
  // Pure JSON path (some transports / negotiations).
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  // SSE path: pull the first `data:` line.
  const match = trimmed.match(/^data:\s*(.+)$/m);
  if (!match) {
    throw new Error(
      `MCP response is neither JSON nor SSE-framed; first 200 chars: ${trimmed.slice(0, 200)}`,
    );
  }
  return JSON.parse(match[1]);
}

/**
 * Best-effort response-body capture for assertion failure messages. Avoids
 * the awkward "expected 200 received 500" with no explanation.
 */
async function safeBody(res: APIResponse): Promise<string> {
  try {
    const text = await res.text();
    return `status=${res.status()} body=${text.slice(0, 500)}`;
  } catch {
    return `status=${res.status()} body=<unreadable>`;
  }
}
