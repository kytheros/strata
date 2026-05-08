// Unit tests for the Strata MCP HTTP client.
//
// These tests exist because two protocol-level bugs shipped to staging in the
// last 48 hours:
//   (a) `tools/call` was sent before the MCP `initialize` handshake, so Strata
//       returned 400 "No valid session ID provided".
//   (b) Strata responded with `Content-Type: text/event-stream` and the client
//       ran `JSON.parse` on the raw SSE frame ("event: message\ndata: {...}").
//
// Both are pure protocol bugs that a network-mocked unit test catches in
// milliseconds — the integration suite missed them because it ran against a
// stub server that always returned `application/json`. We mock `fetch` here
// and assert on call ordering, headers, and body parsing.
//
// Notes:
// - `app/lib/config.ts` snapshots env vars at import time, so we mock that
//   module rather than fighting with `vi.stubEnv` after the fact.
// - We never touch the network. Every test installs its own fetch mock via
//   `vi.stubGlobal` and resets it in `afterEach`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the config module BEFORE importing strata-client. The mock is mutable
// per-test so we can flip authProxyToken to '' to exercise the guard.
// `vi.mock` is hoisted to the top of the file, so the shared state must be
// declared via `vi.hoisted` to be visible to the factory.
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    strata: {
      internalUrl: 'http://strata.internal:3100',
      authProxyToken: 'test-token',
    },
  },
}));
vi.mock('../../app/lib/config', () => ({ config: mockConfig }));

import { StrataClient } from '../../app/lib/strata-client';

// ---------- Mock helpers ----------

interface MockResponseInit {
  status?: number;
  contentType?: string;
  headers?: Record<string, string>;
  body: string;
}

function makeResponse(init: MockResponseInit): Response {
  const headers = new Headers({
    'content-type': init.contentType ?? 'application/json',
    ...init.headers,
  });
  return new Response(init.body, {
    status: init.status ?? 200,
    headers,
  });
}

// JSON-RPC envelope shaped like Strata's `tools/call` reply for store_memory.
function storeMemoryToolReply(memoryId: string, id: number): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: JSON.stringify({ memory_id: memoryId }) }],
    },
  });
}

// JSON-RPC envelope shaped like Strata's `tools/call` reply for search_history.
function searchHistoryToolReply(
  results: Array<Record<string, unknown>>,
  id: number,
): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: JSON.stringify({ results }) }],
    },
  });
}

function initializeReply(id: number): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      serverInfo: { name: 'strata', version: '1.0.0' },
    },
  });
}

beforeEach(() => {
  // Reset config to known-good defaults before each test.
  mockConfig.strata.internalUrl = 'http://strata.internal:3100';
  mockConfig.strata.authProxyToken = 'test-token';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('StrataClient — initialize handshake', () => {
  it('sends MCP `initialize` BEFORE the first tools/call', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          contentType: 'application/json',
          headers: { 'mcp-session-id': 'sess-1' },
          body: initializeReply(1),
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          contentType: 'application/json',
          body: searchHistoryToolReply([{ id: 'r1' }], 2),
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new StrataClient('user-123');
    await client.searchHistory({ query: 'test' });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    // First call MUST be initialize.
    const [, firstInit] = fetchMock.mock.calls[0];
    const firstBody = JSON.parse(firstInit.body as string);
    expect(firstBody.method).toBe('initialize');

    // Second call MUST be tools/call with the search_history tool name.
    const [, secondInit] = fetchMock.mock.calls[1];
    const secondBody = JSON.parse(secondInit.body as string);
    expect(secondBody.method).toBe('tools/call');
    expect(secondBody.params.name).toBe('search_history');
  });

  it('captures mcp-session-id from initialize response and re-sends it on tools/call', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          contentType: 'application/json',
          headers: { 'mcp-session-id': 'abc123' },
          body: initializeReply(1),
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          contentType: 'application/json',
          body: storeMemoryToolReply('mem-7', 2),
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new StrataClient('user-123');
    await client.storeMemory({ memory_text: 'hello' });

    // Initialize request carries no session id (we don't have one yet).
    const initHeaders = fetchMock.mock.calls[0][1].headers as Record<
      string,
      string
    >;
    expect(initHeaders['mcp-session-id']).toBeUndefined();

    // Tools/call MUST carry the session id we captured.
    const toolHeaders = fetchMock.mock.calls[1][1].headers as Record<
      string,
      string
    >;
    expect(toolHeaders['mcp-session-id']).toBe('abc123');
  });

  it('does NOT re-initialize on a second method call (session is cached)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          contentType: 'application/json',
          headers: { 'mcp-session-id': 'abc123' },
          body: initializeReply(1),
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          contentType: 'application/json',
          body: searchHistoryToolReply([], 2),
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          contentType: 'application/json',
          body: storeMemoryToolReply('mem-1', 3),
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new StrataClient('user-123');
    await client.searchHistory({ query: 'q1' });
    await client.storeMemory({ memory_text: 'second turn' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const methods = fetchMock.mock.calls.map(
      (c) => JSON.parse(c[1].body as string).method,
    );
    expect(methods).toEqual(['initialize', 'tools/call', 'tools/call']);

    // Both tools/call requests reuse the same session id.
    const sids = fetchMock.mock.calls
      .slice(1)
      .map((c) => (c[1].headers as Record<string, string>)['mcp-session-id']);
    expect(sids).toEqual(['abc123', 'abc123']);
  });

  it('throws if initialize response is missing mcp-session-id header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        contentType: 'application/json',
        // no mcp-session-id header
        body: initializeReply(1),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new StrataClient('user-123');
    await expect(client.searchHistory({ query: 'x' })).rejects.toThrow(
      /missing mcp-session-id/,
    );
  });
});

describe('StrataClient — response parsing', () => {
  it('parses Server-Sent Events response (text/event-stream)', async () => {
    const sseBody =
      'event: message\n' +
      `data: ${searchHistoryToolReply([{ id: 'r1' }, { id: 'r2' }], 2)}\n\n`;

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          contentType: 'application/json',
          headers: { 'mcp-session-id': 'sess-sse' },
          body: initializeReply(1),
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          contentType: 'text/event-stream',
          body: sseBody,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new StrataClient('user-123');
    const out = await client.searchHistory({ query: 'q' });
    expect(out.results).toEqual([{ id: 'r1' }, { id: 'r2' }]);
  });

  it('parses application/json response with plain JSON.parse', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          contentType: 'application/json',
          headers: { 'mcp-session-id': 'sess-json' },
          body: initializeReply(1),
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          contentType: 'application/json',
          body: searchHistoryToolReply([{ id: 'json-1' }], 2),
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new StrataClient('user-123');
    const out = await client.searchHistory({ query: 'q' });
    expect(out.results).toEqual([{ id: 'json-1' }]);
  });
});

describe('StrataClient — auth headers', () => {
  it('sends X-Strata-Verified and X-Strata-User on every request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          contentType: 'application/json',
          headers: { 'mcp-session-id': 'sess-h' },
          body: initializeReply(1),
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          contentType: 'application/json',
          body: searchHistoryToolReply([], 2),
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new StrataClient('cognito-sub-uuid-7');
    await client.searchHistory({ query: 'q' });

    for (const call of fetchMock.mock.calls) {
      const headers = call[1].headers as Record<string, string>;
      expect(headers['X-Strata-Verified']).toBe('test-token');
      expect(headers['X-Strata-User']).toBe('cognito-sub-uuid-7');
      // Accept header must include both content types per MCP Streamable HTTP spec.
      expect(headers['Accept']).toContain('application/json');
      expect(headers['Accept']).toContain('text/event-stream');
    }
  });

  it('throws a clear error when STRATA_AUTH_PROXY_TOKEN is empty', async () => {
    mockConfig.strata.authProxyToken = '';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const client = new StrataClient('user-123');
    await expect(client.searchHistory({ query: 'q' })).rejects.toThrow(
      /STRATA_AUTH_PROXY_TOKEN not set/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('StrataClient — tool result shape', () => {
  it('searchHistory returns the parsed results array', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          contentType: 'application/json',
          headers: { 'mcp-session-id': 's' },
          body: initializeReply(1),
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          contentType: 'application/json',
          body: searchHistoryToolReply(
            [{ id: 'a', text: 'foo' }, { id: 'b', text: 'bar' }],
            2,
          ),
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new StrataClient('user-123');
    const out = await client.searchHistory({ query: 'foo' });
    expect(out.results).toEqual([
      { id: 'a', text: 'foo' },
      { id: 'b', text: 'bar' },
    ]);
  });

  it('storeMemory returns the memory_id string', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          contentType: 'application/json',
          headers: { 'mcp-session-id': 's' },
          body: initializeReply(1),
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          contentType: 'application/json',
          body: storeMemoryToolReply('mem-xyz', 2),
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new StrataClient('user-123');
    const out = await client.storeMemory({ memory_text: 'remember this' });
    expect(out.memory_id).toBe('mem-xyz');
  });
});

describe('StrataClient — error handling', () => {
  it('throws with HTTP status when Strata returns 500', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({
        status: 500,
        contentType: 'text/plain',
        body: 'internal error',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new StrataClient('user-123');
    await expect(client.searchHistory({ query: 'q' })).rejects.toThrow(
      /HTTP 500/,
    );
  });

  it('throws when STRATA_INTERNAL_URL is empty', async () => {
    mockConfig.strata.internalUrl = '';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const client = new StrataClient('user-123');
    await expect(client.searchHistory({ query: 'q' })).rejects.toThrow(
      /STRATA_INTERNAL_URL not set/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces JSON-RPC error envelope from initialize', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32600, message: 'Invalid Request' },
        }),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new StrataClient('user-123');
    await expect(client.searchHistory({ query: 'q' })).rejects.toThrow(
      /initialize error/,
    );
  });

  it('surfaces JSON-RPC error envelope from tools/call', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          contentType: 'application/json',
          headers: { 'mcp-session-id': 's' },
          body: initializeReply(1),
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          contentType: 'application/json',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            error: { code: -32602, message: 'Invalid params' },
          }),
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new StrataClient('user-123');
    await expect(
      client.searchHistory({ query: 'q' }),
    ).rejects.toThrow(/search_history error/);
  });
});
