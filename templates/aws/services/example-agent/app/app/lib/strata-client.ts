// Strata MCP HTTP client.
//
// Talks to Strata-on-AWS (the Phase 2 service) over the internal Service
// Connect endpoint. Strata runs in multi-tenant mode — see strata/CLAUDE.md
// §"Transport Modes" — and gates access via two headers:
//
//   X-Strata-User      — caller's user UUID (Cognito sub for our deploy)
//   X-Strata-Verified  — shared sentinel matching STRATA_AUTH_PROXY_TOKEN;
//                        proves the calling proxy has already verified the
//                        caller's identity.
//
// The example-agent backend acts as the auth proxy here: it has already
// verified the Cognito JWT before this client is constructed, so the sub
// claim it passes is trustworthy. The X-Strata-Verified token comes from
// Secrets Manager via the ECS task definition.
//
// MCP transport: Streamable HTTP at POST /mcp (per the MCP spec). Strata's
// multi-tenant transport (StreamableHTTPServerTransport) requires:
//
//   1. The very first request on a logical session MUST be a JSON-RPC
//      `initialize` call. The response carries an `mcp-session-id` header
//      that identifies the session.
//   2. Every subsequent request (e.g. `tools/call`) MUST include that
//      `mcp-session-id` header — without it, Strata returns
//      `400 "Bad Request: No valid session ID provided"`.
//   3. The `Accept` header MUST list both `application/json` and
//      `text/event-stream`. Strata picks SSE for tool responses; missing
//      this header causes the MCP SDK to drop the connection mid-handshake
//      (manifests as `ECONNRESET` on the client side).
//
// We mirror the canary lambda's working pattern (services/canary/lambda/index.mjs).

import { config } from './config';

export interface StoreMemoryArgs {
  memory_text: string;
  type?: 'episodic' | 'semantic' | 'procedural';
  tags?: string[];
}

export interface StoreMemoryResult {
  memory_id: string;
}

export interface SearchHistoryArgs {
  query: string;
  limit?: number;
  before?: string;
  after?: string;
  project?: string;
}

export interface SearchHistoryResult {
  results: Array<Record<string, unknown>>;
}

export class StrataClient {
  // userId is the verified Cognito `sub` claim. Callers MUST verify the JWT
  // before constructing this client — passing an unverified value would
  // forge ownership of another user's memory.
  constructor(private readonly userId: string) {}

  // Per-instance MCP session id. Lazily populated on the first request.
  // Strata caches per-user transport sessions; once we have an id we reuse
  // it across both searchHistory and storeMemory in the same chat turn.
  private sessionId: string | null = null;

  // Monotonic JSON-RPC request id within this client instance.
  private nextId = 1;

  async storeMemory(args: StoreMemoryArgs): Promise<StoreMemoryResult> {
    return (await this.callMcpTool('store_memory', args)) as StoreMemoryResult;
  }

  async searchHistory(args: SearchHistoryArgs): Promise<SearchHistoryResult> {
    return (await this.callMcpTool(
      'search_history',
      args,
    )) as SearchHistoryResult;
  }

  /**
   * Send a JSON-RPC request to Strata's /mcp endpoint with all required
   * Streamable-HTTP headers. Returns the parsed JSON-RPC envelope plus the
   * raw `Response` so callers can read the `mcp-session-id` header on the
   * initialize response.
   */
  private async postMcp(
    body: Record<string, unknown>,
  ): Promise<{ response: Response; envelope: Record<string, unknown> }> {
    const baseUrl = config.strata.internalUrl;
    if (!baseUrl) {
      throw new Error(
        '[strata-client] STRATA_INTERNAL_URL not set — cannot reach Strata service.',
      );
    }
    const token = config.strata.authProxyToken;
    if (!token) {
      throw new Error(
        '[strata-client] STRATA_AUTH_PROXY_TOKEN not set — Strata will reject the request.',
      );
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // MCP Streamable HTTP transport requires both content types in Accept.
      // Strata's SDK transport will drop the connection if either is missing.
      Accept: 'application/json, text/event-stream',
      'X-Strata-User': this.userId,
      'X-Strata-Verified': token,
    };
    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
    }

    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '<unreadable>');
      throw new Error(
        `[strata-client] HTTP ${response.status}: ${text.slice(0, 500)}`,
      );
    }

    // Strata may respond with either pure JSON or SSE depending on the
    // SDK's negotiation. SSE looks like: `event: message\ndata: {...}\n\n`.
    // Extract the JSON body from the first `data:` line in SSE mode.
    const text = await response.text();
    const contentType = response.headers.get('content-type') || '';
    const jsonText = contentType.includes('text/event-stream')
      ? (text.match(/^data:\s*(.+)$/m)?.[1] ?? '')
      : text;

    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(jsonText);
    } catch {
      throw new Error(
        `[strata-client] Failed to parse MCP response (content-type=${contentType}): ${text.slice(0, 500)}`,
      );
    }
    return { response, envelope };
  }

  /**
   * Lazily perform the MCP `initialize` handshake. Caches the
   * `mcp-session-id` returned in the response header so subsequent calls
   * route to the same per-user session.
   */
  private async ensureSession(): Promise<void> {
    if (this.sessionId) return;

    const { response, envelope } = await this.postMcp({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'example-agent', version: '1.0.0' },
      },
    });

    if ((envelope as { error?: unknown }).error) {
      throw new Error(
        `[strata-client] initialize error: ${JSON.stringify(
          (envelope as { error: unknown }).error,
        )}`,
      );
    }

    const sid = response.headers.get('mcp-session-id');
    if (!sid) {
      throw new Error(
        '[strata-client] initialize response missing mcp-session-id header — ' +
          'Strata may not be in multi-tenant mode or proxy stripped the header.',
      );
    }
    this.sessionId = sid;
  }

  private async callMcpTool(name: string, args: unknown): Promise<unknown> {
    await this.ensureSession();

    const { envelope } = await this.postMcp({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    });

    const json = envelope as {
      result?: {
        content?: Array<{ type: string; text?: string }>;
      };
      error?: unknown;
    };

    if (json.error) {
      throw new Error(
        `[strata-client] ${name} error: ${JSON.stringify(json.error)}`,
      );
    }

    // MCP tools return { content: [{ type: "text", text: "<json>" }] }.
    // Strata's store_memory and search_history both return JSON payloads
    // wrapped in a single text content block — we parse it back to an
    // object for ergonomic consumption upstream.
    const text = json.result?.content?.[0]?.text;
    if (text == null) {
      return json.result;
    }
    try {
      return JSON.parse(text);
    } catch {
      // Tool returned a non-JSON text payload (rare, but supported by the
      // MCP spec). Surface the raw text so the caller can decide.
      return { text };
    }
  }
}
