/**
 * Multi-tenant Streamable HTTP transport for Strata MCP server.
 *
 * Routes MCP requests by user ID (from X-Strata-User header) to per-user
 * MCP server instances, each backed by their own SQLite database.
 *
 * Each user gets:
 *   - Their own SQLite database at {baseDir}/{userId}/strata.db
 *   - Their own MCP server instance with isolated caches
 *   - Their own StreamableHTTPServerTransport sessions
 *
 * Watchers (RealtimeWatcher, IncrementalIndexer) are NOT started in
 * multi-tenant mode -- they are per-database file watchers not applicable
 * to SaaS deployments where there is no active Claude Code session.
 */

import { createServer as createHttpServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../server.js";
import type { HttpTransportHandle } from "./http-transport.js";

/** UUID v4 pattern for header validation */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Max concurrent MCP sessions per user — prevents session accumulation DoS */
const MAX_SESSIONS_PER_USER = 10;

export interface MultiTenantHttpTransportOptions {
  port: number;
  host?: string;
  baseDir: string;
  maxDbs?: number;
  idleTimeoutMs?: number;
}

/**
 * Per-user server state: MCP server + transport sessions.
 */
interface UserEntry {
  userId: string;
  mcpServer: ReturnType<typeof createServer>;
  transports: Map<string, StreamableHTTPServerTransport>;
  lastAccess: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Pool statistics for health endpoint.
 */
interface PoolStats {
  open: number;
  maxOpen: number;
  hits: number;
  misses: number;
}

/**
 * Start the multi-tenant MCP server over Streamable HTTP.
 *
 * Routes:
 *   GET  /health     -> health check with pool stats
 *   GET  /admin/pool -> per-user pool details
 *   POST /mcp        -> MCP JSON-RPC (requires X-Strata-User header)
 *   GET  /mcp        -> SSE stream for existing session
 *   DELETE /mcp      -> session termination
 */
export async function startMultiTenantHttpTransport(
  options: MultiTenantHttpTransportOptions
): Promise<HttpTransportHandle> {
  const {
    port,
    host = "0.0.0.0",
    baseDir,
    maxDbs = 200,
    idleTimeoutMs = 300_000,
  } = options;

  // ── User server pool (LRU) ──────────────────────────────────────────
  // Map iteration order = insertion order. Re-insertion on access promotes to MRU.
  const users = new Map<string, UserEntry>();
  let hits = 0;
  let misses = 0;

  // Map mcp-session-id -> { userId, transport }
  // Enables routing subsequent requests by session ID without requiring the header
  const sessionIndex = new Map<
    string,
    { userId: string; transport: StreamableHTTPServerTransport }
  >();

  function getPoolStats(): PoolStats {
    return { open: users.size, maxOpen: maxDbs, hits, misses };
  }

  function getPoolEntries(): Array<{ userId: string; lastAccess: number; alive: boolean }> {
    const result: Array<{ userId: string; lastAccess: number; alive: boolean }> = [];
    for (const [, entry] of users) {
      result.push({
        userId: entry.userId,
        lastAccess: entry.lastAccess,
        alive: true,
      });
    }
    return result;
  }

  /**
   * Create an MCP server for a specific user with an explicit data directory.
   * No global state mutation — safe for concurrent async operations.
   */
  function createUserServer(userId: string): ReturnType<typeof createServer> {
    return createServer({ dataDir: join(baseDir, userId) });
  }

  /**
   * Evict a user entry: close all transports, close IndexManager/DB.
   */
  async function evictUser(userId: string): Promise<void> {
    const entry = users.get(userId);
    if (!entry) return;

    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }

    // Close all MCP transports for this user
    for (const [sid, transport] of entry.transports) {
      try {
        await transport.close();
      } catch {
        // ignore cleanup errors
      }
      sessionIndex.delete(sid);
    }
    entry.transports.clear();

    // Close the database/IndexManager
    try {
      entry.mcpServer.indexManager?.close();
    } catch {
      // ignore cleanup errors
    }

    users.delete(userId);
  }

  /**
   * Evict LRU entries if pool is at capacity.
   */
  async function evictIfNeeded(): Promise<void> {
    while (users.size >= maxDbs) {
      const first = users.keys().next();
      if (first.done) break;
      await evictUser(first.value);
    }
  }

  /**
   * Get or create the user server entry. Handles LRU promotion and eviction.
   */
  async function acquireUser(userId: string): Promise<UserEntry> {
    const existing = users.get(userId);
    if (existing) {
      hits++;
      // Cancel idle timer
      if (existing.idleTimer) {
        clearTimeout(existing.idleTimer);
        existing.idleTimer = null;
      }
      existing.lastAccess = Date.now();
      // Promote to MRU by re-inserting
      users.delete(userId);
      users.set(userId, existing);
      return existing;
    }

    misses++;
    await evictIfNeeded();

    const mcpServer = createUserServer(userId);

    const entry: UserEntry = {
      userId,
      mcpServer,
      transports: new Map(),
      lastAccess: Date.now(),
      idleTimer: null,
    };

    users.set(userId, entry);
    return entry;
  }

  /**
   * Release a user (mark idle, start eviction timer).
   */
  function releaseUser(userId: string): void {
    const entry = users.get(userId);
    if (!entry) return;

    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
    }
    entry.idleTimer = setTimeout(() => {
      evictUser(userId).catch(() => {});
    }, idleTimeoutMs);
  }

  // ── HTTP server ────────────────────────────────────────────────────

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // ── Health endpoint ──────────────────────────────────────────────
    if (url.pathname === "/health") {
      const stats = getPoolStats();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          mode: "multi-tenant",
          pool: {
            open: stats.open,
            maxOpen: stats.maxOpen,
            hits: stats.hits,
            misses: stats.misses,
            hitRate:
              stats.hits + stats.misses > 0
                ? ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(1) + "%"
                : "0%",
          },
          uptime: Math.floor(process.uptime()),
        })
      );
      return;
    }

    // ── Admin pool endpoint ──────────────────────────────────────────
    if (url.pathname === "/admin/pool") {
      const entries = getPoolEntries();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ entries }));
      return;
    }

    // ── MCP endpoint ─────────────────────────────────────────────────
    if (url.pathname === "/mcp") {
      try {
        await handleMcpRequest(req, res);
      } catch (error) {
        console.error(
          "[multi-tenant] Error handling MCP request:",
          error instanceof Error ? error.message : "unknown error"
        );
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

  async function handleMcpRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse
  ): Promise<void> {
    const method = req.method?.toUpperCase();

    if (method === "POST") {
      const body = await readBody(req);
      const parsed = JSON.parse(body);

      const mcpSessionId = req.headers["mcp-session-id"] as string | undefined;

      // ── Existing session (route by mcp-session-id) ────────────────
      if (mcpSessionId) {
        const sessionEntry = sessionIndex.get(mcpSessionId);
        if (sessionEntry) {
          // Touch the user's LRU entry
          const userEntry = users.get(sessionEntry.userId);
          if (userEntry) {
            if (userEntry.idleTimer) {
              clearTimeout(userEntry.idleTimer);
              userEntry.idleTimer = null;
            }
            userEntry.lastAccess = Date.now();
            users.delete(sessionEntry.userId);
            users.set(sessionEntry.userId, userEntry);
          }

          await sessionEntry.transport.handleRequest(req, res, parsed);
          releaseUser(sessionEntry.userId);
          return;
        }
      }

      // TODO: Extract X-Strata-Model header and inject into MCP tool args
      // for model-aware retrieval routing. See http-transport.ts for details.
      // const _modelHint = req.headers["x-strata-model"] as string | undefined;

      // ── New session request ───────────────────────────────────────
      const userId = req.headers["x-strata-user"] as string | undefined;

      if (!userId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Missing X-Strata-User header",
            },
            id: parsed?.id ?? null,
          })
        );
        return;
      }

      if (!UUID_RE.test(userId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Invalid X-Strata-User header: must be UUID format",
            },
            id: parsed?.id ?? null,
          })
        );
        return;
      }

      if (!isInitializeRequest(parsed)) {
        // Non-initialize request without a valid session
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Bad Request: No valid session ID provided",
            },
            id: parsed?.id ?? null,
          })
        );
        return;
      }

      // ── Initialize new session for this user ─────────────────────
      const userEntry = await acquireUser(userId);

      // Cap sessions per user to prevent unbounded accumulation
      if (userEntry.transports.size >= MAX_SESSIONS_PER_USER) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: `Too many active sessions for this user (max ${MAX_SESSIONS_PER_USER})`,
            },
            id: null,
          })
        );
        releaseUser(userId);
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          userEntry.transports.set(sid, transport);
          sessionIndex.set(sid, { userId, transport });
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          userEntry.transports.delete(sid);
          sessionIndex.delete(sid);
        }
      };

      // The MCP SDK's Protocol only supports one transport at a time.
      // Close the previous connection (if any) before connecting the new session.
      // This is safe: tool request handlers survive close/reconnect cycles.
      if (userEntry.mcpServer.server.isConnected()) {
        await userEntry.mcpServer.server.close();
      }

      await userEntry.mcpServer.server.connect(transport);
      await transport.handleRequest(req, res, parsed);
      releaseUser(userId);
      return;
    }

    if (method === "GET") {
      const mcpSessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!mcpSessionId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing mcp-session-id header" }));
        return;
      }

      const sessionEntry = sessionIndex.get(mcpSessionId);
      if (!sessionEntry) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid or expired session ID" }));
        return;
      }

      await sessionEntry.transport.handleRequest(req, res);
      return;
    }

    if (method === "DELETE") {
      const mcpSessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!mcpSessionId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing mcp-session-id header" }));
        return;
      }

      const sessionEntry = sessionIndex.get(mcpSessionId);
      if (!sessionEntry) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid or expired session ID" }));
        return;
      }

      await sessionEntry.transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  return new Promise((resolve, reject) => {
    httpServer.on("error", reject);

    httpServer.listen(port, host, () => {
      console.log(`Strata multi-tenant MCP server listening on ${host}:${port}`);
      console.log(`  Health: http://${host}:${port}/health`);
      console.log(`  Admin:  http://${host}:${port}/admin/pool`);
      console.log(`  MCP:    http://${host}:${port}/mcp`);
      console.log(`  Mode:   multi-tenant (base: ${baseDir}, max DBs: ${maxDbs})`);

      const handle: HttpTransportHandle = {
        server: httpServer,
        port,
        close: async () => {
          // Evict all users (closes transports, databases)
          const userIds = [...users.keys()];
          for (const userId of userIds) {
            await evictUser(userId);
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

/** Max request body size: 1MB — prevents memory exhaustion from oversized POSTs */
const MAX_BODY_BYTES = 1_048_576;

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
