/**
 * Cross-transport provenance tests.
 *
 * Verifies that the provenance bracket-handle citation
 * ([mem:<id> sess:<id> t:<date>]) survives MCP JSON-RPC
 * transport serialization/deserialization on the HTTP transport.
 *
 * Note: multi-tenant HTTP transport tests are skipped on Windows
 * (ECONNRESET under Windows TCP stack). These tests use the single-tenant
 * HTTP transport which works cross-platform.
 */
import { describe, it, expect, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { startHttpTransport, type HttpTransportHandle } from "../../src/transports/http-transport.js";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import { handleSearchHistory } from "../../src/tools/search-history.js";
import type { KnowledgeEntry } from "../../src/knowledge/knowledge-store.js";

// Bracket-handle pattern
const BRACKET_RE = /\[mem:[a-z]_[0-9a-f]{6}( sess:[a-z]_[0-9a-f]{6})? t:\d{4}-\d{2}-\d{2}\]/;

function hexId(prefix: string): string {
  const hex = () => Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  return `${prefix}_${hex()}-${hex()}-${hex()}-${hex()}`;
}

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: hexId("k"),
    type: "decision",
    project: "transport-test-project",
    sessionId: hexId("s"),
    timestamp: Date.now(),
    summary: "use Postgres for transport test",
    details: "verified through MCP JSON-RPC transport layer",
    tags: [],
    relatedFiles: [],
    ...overrides,
  };
}

/** Parse SSE or direct JSON response from MCP endpoint */
function parseMcpResponse(text: string): unknown {
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      try {
        return JSON.parse(line.slice(6));
      } catch {
        // skip
      }
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Perform an MCP initialize handshake and return the session id. */
async function initSession(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "provenance-transport-test", version: "1.0.0" },
      },
    }),
  });
  expect(res.status).toBe(200);
  const sessionId = res.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  await res.text(); // consume body
  return sessionId!;
}

/** Call a tool via an established MCP session. */
async function callTool(
  baseUrl: string,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  return parseMcpResponse(await res.text());
}

let handle: HttpTransportHandle | undefined;

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = undefined;
  }
});

describe("HTTP transport: provenance bracket-handle survives MCP serialization", () => {
  it("search_history result contains provenance bracket handle through HTTP transport", async () => {
    // Set up in-memory Strata stack
    const db = openDatabase(":memory:");
    const docStore = new SqliteDocumentStore(db);
    const knowledgeStore = new SqliteKnowledgeStore(db);
    const engine = new SqliteSearchEngine(docStore, null, null, null, knowledgeStore);

    const entry = makeEntry();
    await knowledgeStore.addEntry(entry);

    // Create a minimal McpServer wrapping search_history
    const server = new McpServer(
      { name: "provenance-test", version: "2.2.0" },
      { capabilities: { tools: {} } }
    );

    server.tool(
      "search_history",
      "Search history",
      { query: z.string() },
      async ({ query }) => {
        const text = await handleSearchHistory(
          engine,
          { query },
          db,
          undefined,
          knowledgeStore
        );
        return { content: [{ type: "text" as const, text }] };
      }
    );

    handle = await startHttpTransport({
      port: 0,
      serverFactory: () => ({ server }),
    });

    const addr = handle.server.address();
    if (typeof addr !== "object" || addr === null) throw new Error("No address");
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    const sessionId = await initSession(baseUrl);
    const data = await callTool(baseUrl, sessionId, "search_history", {
      query: "transport test",
    }) as { result?: { content?: Array<{ text?: string }> } };

    const text = data?.result?.content?.[0]?.text ?? "";
    expect(text).toMatch(BRACKET_RE);
  });
});
