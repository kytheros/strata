/**
 * Streamable HTTP transport for the Strata MCP server.
 *
 * Uses the MCP SDK's StreamableHTTPServerTransport with Node.js http module.
 * Handles session management, routing, and graceful shutdown.
 */

import { createServer as createHttpServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { handleHealthRequest } from "./health.js";
import { createServer } from "../server.js";

export interface HttpTransportOptions {
  port: number;
  host?: string;
  /** Factory to create a fresh McpServer per session. Defaults to community createServer(). */
  serverFactory?: () => { server: McpServer };
}

export interface HttpTransportHandle {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

/**
 * Start the MCP server over Streamable HTTP.
 *
 * Routes:
 *   GET  /health  -> health check
 *   POST /mcp     -> MCP JSON-RPC (initialize or existing session)
 *   GET  /mcp     -> SSE stream for existing session
 *   DELETE /mcp   -> session termination
 */
export async function startHttpTransport(
  options: HttpTransportOptions
): Promise<HttpTransportHandle> {
  const { port, host = "0.0.0.0", serverFactory = createServer } = options;

  // Map of session ID -> transport
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Health endpoint
    if (url.pathname === "/health") {
      handleHealthRequest(req, res);
      return;
    }

    // MCP endpoint
    if (url.pathname === "/mcp") {
      try {
        await handleMcpRequest(req, res, transports, serverFactory);
      } catch (error) {
        console.error("Error handling MCP request:", error instanceof Error ? error.message : "unknown error");
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal server error" },
              id: null,
            })
          );
        }
      }
      return;
    }

    // 404 for everything else
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  return new Promise((resolve, reject) => {
    httpServer.on("error", reject);

    httpServer.listen(port, host, () => {
      console.log(`Strata MCP HTTP server listening on ${host}:${port}`);
      console.log(`  Health: http://${host}:${port}/health`);
      console.log(`  MCP:    http://${host}:${port}/mcp`);
      if (host !== "127.0.0.1" && host !== "localhost") {
        console.warn(
          "  WARNING: Server is listening on a non-loopback address without TLS."
        );
        console.warn(
          "  For production use, place behind a reverse proxy with HTTPS."
        );
      }

      const handle: HttpTransportHandle = {
        server: httpServer,
        port,
        close: async () => {
          // Close all active transports
          for (const [sid, transport] of transports) {
            try {
              await transport.close();
            } catch {
              // ignore cleanup errors
            }
            transports.delete(sid);
          }
          // Close HTTP server
          await new Promise<void>((res, rej) => {
            httpServer.close((err) => (err ? rej(err) : res()));
          });
        },
      };

      resolve(handle);
    });
  });
}

async function handleMcpRequest(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  transports: Map<string, StreamableHTTPServerTransport>,
  serverFactory: () => { server: McpServer },
): Promise<void> {
  const method = req.method?.toUpperCase();

  if (method === "POST") {
    // Read request body
    const body = await readBody(req);
    const parsed = JSON.parse(body);

    // TODO: Extract X-Strata-Model header and inject into MCP tool args
    // for model-aware retrieval routing. The MCP SDK does not expose a
    // per-request context to tool handlers, so this requires either:
    // (a) a session-level metadata store keyed by transport session ID, or
    // (b) the client passing `model` as an explicit tool parameter (current approach).
    // const _modelHint = req.headers["x-strata-model"] as string | undefined;

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      // Existing session
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, parsed);
      return;
    }

    if (!sessionId && isInitializeRequest(parsed)) {
      // New session — create a fresh MCP server per session.
      // The MCP SDK only allows one transport per Server instance,
      // matching the canonical pattern from the SDK docs.
      const { server: sessionServer } = serverFactory();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) transports.delete(sid);
      };

      await sessionServer.connect(transport);
      await transport.handleRequest(req, res, parsed);
      return;
    }

    // Invalid request
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
        id: null,
      })
    );
    return;
  }

  if (method === "GET") {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or missing session ID" }));
      return;
    }
    await transports.get(sessionId)!.handleRequest(req, res);
    return;
  }

  if (method === "DELETE") {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or missing session ID" }));
      return;
    }
    await transports.get(sessionId)!.handleRequest(req, res);
    return;
  }

  res.writeHead(405, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Method not allowed" }));
}

/** Max request body size — matches multi-tenant-http-transport.ts. */
const MAX_BODY_BYTES = 1_048_576; // 1 MB

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("Request body exceeds 1MB limit"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
