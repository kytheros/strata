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
// MCP transport: Streamable HTTP at POST /mcp (per the MCP spec). Each
// request is a JSON-RPC envelope; for our needs we make tools/call requests
// only.

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

  async storeMemory(args: StoreMemoryArgs): Promise<StoreMemoryResult> {
    return (await this.callMcpTool('store_memory', args)) as StoreMemoryResult;
  }

  async searchHistory(args: SearchHistoryArgs): Promise<SearchHistoryResult> {
    return (await this.callMcpTool(
      'search_history',
      args,
    )) as SearchHistoryResult;
  }

  private async callMcpTool(name: string, args: unknown): Promise<unknown> {
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

    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Strata-User': this.userId,
        'X-Strata-Verified': token,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name, arguments: args },
        id: 1,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `[strata-client] ${name} failed: ${response.status} ${body}`,
      );
    }

    const json = (await response.json()) as {
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
