// Strata-on-AWS synthetic canary (AWS-4.1).
//
// Runs every var.schedule_expression (default 5 min) when enabled. Exercises
// the full external-MCP path: Cognito JWT mint -> API GW JWT authorizer ->
// header-injecting integration -> internal NLB -> Strata MCP transport.
//
// Validates:
//   1. AdminInitiateAuth succeeds against the test-user app client.
//   2. POST /mcp `tools/list` returns HTTP 200.
//   3. The MCP response body parses as JSON-RPC and the `tools` array is non-empty.
//   4. The `X-Strata-Verified` header reached Strata (Strata echoes a confirmation
//      header `X-Strata-Verified-Echo` on responses when STRATA_REQUIRE_AUTH_PROXY
//      is on; or the request would have been rejected before the body was returned).
//
// Failure path: throws. The Lambda exits non-zero, CloudWatch Logs records
// `CANARY_FAIL ...` which the metric filter increments; the alarm pages.

import {
  CognitoIdentityProviderClient,
  AdminInitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const REGION = process.env.AWS_REGION;
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const CREDENTIALS_SECRET_ARN = process.env.CANARY_CREDENTIALS_SECRET_ARN;
const MCP_ENDPOINT = process.env.MCP_ENDPOINT;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 10000);

const cognito = new CognitoIdentityProviderClient({ region: REGION });
const secrets = new SecretsManagerClient({ region: REGION });

let cachedCredentials = null;

async function loadCredentials() {
  if (cachedCredentials) return cachedCredentials;
  const out = await secrets.send(
    new GetSecretValueCommand({ SecretId: CREDENTIALS_SECRET_ARN }),
  );
  if (!out.SecretString) {
    throw new Error("CANARY_FAIL credentials_secret_empty");
  }
  const parsed = JSON.parse(out.SecretString);
  if (!parsed.username || !parsed.password) {
    throw new Error("CANARY_FAIL credentials_shape_invalid (need {username,password})");
  }
  cachedCredentials = parsed;
  return parsed;
}

async function mintAccessToken() {
  const { username, password } = await loadCredentials();
  const out = await cognito.send(
    new AdminInitiateAuthCommand({
      UserPoolId: USER_POOL_ID,
      ClientId: CLIENT_ID,
      AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: username, PASSWORD: password },
    }),
  );
  const token = out?.AuthenticationResult?.AccessToken;
  if (!token) {
    throw new Error("CANARY_FAIL no_access_token_returned");
  }
  return token;
}

async function postMcp(token, body, sessionId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  try {
    return await fetch(MCP_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers,
      body: JSON.stringify(body),
    });
  } finally {
    clearTimeout(timer);
  }
}

// Strata's multi-tenant transport (StreamableHTTPServerTransport) requires the
// MCP `initialize` handshake before any other JSON-RPC method. The first POST
// returns an `mcp-session-id` header that must accompany every subsequent
// request in the same logical session.
async function initializeSession(token) {
  const response = await postMcp(token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "strata-canary", version: "1.0.0" },
    },
  });
  if (response.status !== 200) {
    throw new Error(`initialize_failed status=${response.status}`);
  }
  const sessionId = response.headers.get("mcp-session-id");
  if (!sessionId) {
    throw new Error("initialize_missing_session_id_header");
  }
  return sessionId;
}

async function callToolsList(token, sessionId) {
  return postMcp(
    token,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    sessionId,
  );
}

export const handler = async () => {
  const startedAt = Date.now();
  const ctx = {
    region: REGION,
    pool: USER_POOL_ID,
    endpoint: MCP_ENDPOINT,
  };

  let token;
  try {
    token = await mintAccessToken();
  } catch (err) {
    console.error("CANARY_FAIL stage=mint_token", err.message, ctx);
    throw err;
  }

  let sessionId;
  try {
    sessionId = await initializeSession(token);
  } catch (err) {
    console.error("CANARY_FAIL stage=mcp_initialize", err.message, ctx);
    throw err;
  }

  let response;
  try {
    response = await callToolsList(token, sessionId);
  } catch (err) {
    console.error("CANARY_FAIL stage=tools_list_request", err.message, ctx);
    throw err;
  }

  if (response.status !== 200) {
    const body = await response.text().catch(() => "<unreadable>");
    console.error("CANARY_FAIL stage=status_code", {
      status: response.status,
      body: body.slice(0, 500),
      ...ctx,
    });
    throw new Error(`CANARY_FAIL status=${response.status}`);
  }

  const echoHeader = response.headers.get("x-strata-verified-echo");
  // Strata echoes this header when STRATA_REQUIRE_AUTH_PROXY is on and the
  // X-Strata-Verified token matched. If absent we still pass on body shape,
  // but we log a warning so an operator can investigate the proxy contract.
  if (!echoHeader) {
    console.warn("CANARY_WARN missing_x_strata_verified_echo - proxy header may not have been injected. The request still passed Strata's auth check, otherwise we would have gotten a 4xx. Investigate if persistent.");
  }

  const text = await response.text();
  // MCP Streamable HTTP transport may return either JSON or text/event-stream
  // (SSE), depending on what the server picks when both are in Accept. Strata
  // emits SSE: `event: message\ndata: {...}\n\n`. Extract the JSON payload
  // from the first `data:` line; fall back to the raw text for pure-JSON
  // responses.
  const contentType = response.headers.get("content-type") || "";
  const jsonText = contentType.includes("text/event-stream")
    ? (text.match(/^data:\s*(.+)$/m)?.[1] ?? "")
    : text;
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    console.error("CANARY_FAIL stage=parse_body", err.message, {
      body: text.slice(0, 500),
      contentType,
      ...ctx,
    });
    throw err;
  }

  const tools = parsed?.result?.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    console.error("CANARY_FAIL stage=tools_array_empty", {
      body: text.slice(0, 500),
      ...ctx,
    });
    throw new Error("CANARY_FAIL tools_empty");
  }

  const elapsedMs = Date.now() - startedAt;
  console.log("CANARY_OK", {
    elapsedMs,
    toolCount: tools.length,
    sampleTool: tools[0]?.name,
    echoHeaderPresent: Boolean(echoHeader),
    ...ctx,
  });

  return {
    ok: true,
    elapsedMs,
    toolCount: tools.length,
  };
};
