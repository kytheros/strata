import { describe, it, expect, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { startHttpTransport, type HttpTransportHandle } from "../../src/transports/http-transport.js";

function createTestServer(): McpServer {
  const server = new McpServer(
    { name: "test-server", version: "0.0.1" },
    { capabilities: { tools: {} } }
  );

  server.tool(
    "echo",
    "Echo back the input",
    { message: z.string() },
    async ({ message }) => ({
      content: [{ type: "text", text: message }],
    })
  );

  return server;
}

let handle: HttpTransportHandle | undefined;

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = undefined;
  }
});

describe("HTTP Transport", () => {
  it("should start on the specified port", async () => {
    handle = await startHttpTransport({ port: 0, serverFactory: () => ({ server: createTestServer() }) }); // port 0 = random free port
    expect(handle.port).toBe(0);
    // The actual port is assigned by the OS
    const addr = handle.server.address();
    expect(addr).not.toBeNull();
    if (typeof addr === "object" && addr !== null) {
      expect(addr.port).toBeGreaterThan(0);
    }
  });

  it("should return 200 with JSON from /health", async () => {
    handle = await startHttpTransport({ port: 0, serverFactory: () => ({ server: createTestServer() }) });
    const addr = handle.server.address();
    if (typeof addr !== "object" || addr === null) throw new Error("No address");

    const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
    expect(typeof body.uptime).toBe("number");
  });

  it("should return 404 for unknown paths", async () => {
    handle = await startHttpTransport({ port: 0, serverFactory: () => ({ server: createTestServer() }) });
    const addr = handle.server.address();
    if (typeof addr !== "object" || addr === null) throw new Error("No address");

    const res = await fetch(`http://127.0.0.1:${addr.port}/unknown`);
    expect(res.status).toBe(404);
  });

  it("should handle MCP initialize via HTTP POST", async () => {
    handle = await startHttpTransport({ port: 0, serverFactory: () => ({ server: createTestServer() }) });
    const addr = handle.server.address();
    if (typeof addr !== "object" || addr === null) throw new Error("No address");

    const baseUrl = `http://127.0.0.1:${addr.port}`;

    // Send initialize request
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json",
        "Accept": "text/event-stream, application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.1" },
        },
      }),
    });

    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    // Read the SSE response body to get the initialize result
    const text = await initRes.text();
    expect(text).toContain("protocolVersion");
  });

  it("should reject POST without session ID when not initializing", async () => {
    handle = await startHttpTransport({ port: 0, serverFactory: () => ({ server: createTestServer() }) });
    const addr = handle.server.address();
    if (typeof addr !== "object" || addr === null) throw new Error("No address");

    const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json",
        "Accept": "text/event-stream, application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });

    expect(res.status).toBe(400);
  });

  it("should return 405 for unsupported methods", async () => {
    handle = await startHttpTransport({ port: 0, serverFactory: () => ({ server: createTestServer() }) });
    const addr = handle.server.address();
    if (typeof addr !== "object" || addr === null) throw new Error("No address");

    const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
      method: "PUT",
      headers: { "Content-Type": "application/json",
        "Accept": "text/event-stream, application/json" },
      body: "{}",
    });

    expect(res.status).toBe(405);
  });

  it("should complete tools/list after initialize", async () => {
    handle = await startHttpTransport({ port: 0, serverFactory: () => ({ server: createTestServer() }) });
    const addr = handle.server.address();
    if (typeof addr !== "object" || addr === null) throw new Error("No address");

    const baseUrl = `http://127.0.0.1:${addr.port}`;

    // Initialize
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json",
        "Accept": "text/event-stream, application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.1" },
        },
      }),
    });

    const sessionId = initRes.headers.get("mcp-session-id")!;
    // Consume init response
    await initRes.text();

    // Send initialized notification
    await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream, application/json",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });

    // Now list tools
    const listRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream, application/json",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });

    expect(listRes.status).toBe(200);
    const text = await listRes.text();
    expect(text).toContain("echo");
  });

  it("should shut down gracefully", async () => {
    handle = await startHttpTransport({ port: 0, serverFactory: () => ({ server: createTestServer() }) });

    await handle.close();

    // Verify server is closed by checking that we can't connect
    const addr = handle.server.address();
    // After close, address should be null
    expect(handle.server.listening).toBe(false);

    handle = undefined; // already closed
  });
});
