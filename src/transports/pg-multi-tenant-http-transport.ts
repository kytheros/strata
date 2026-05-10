/**
 * Postgres-backed multi-tenant Streamable HTTP transport for Strata MCP server.
 *
 * Routes MCP requests by user ID (from X-Strata-User header) to per-user
 * MCP server instances, each backed by a shared pg.Pool with row-level
 * user scoping.
 *
 * When DATABASE_URL is set, the CLI (src/cli.ts) routes to this transport
 * instead of the SQLite multi-tenant transport. Without this file, Tier B
 * Cloud SQL deployments silently wrote to ephemeral SQLite on every request.
 *
 * Key differences from multi-tenant-http-transport.ts (SQLite):
 *   - Accepts `connectionString` (DATABASE_URL) instead of `baseDir`
 *   - Each user entry holds a StorageContext from createPgStorage (shared pool,
 *     user-scoped via userId row filter) instead of a per-file SQLite database
 *   - `--max-dbs` / maxDbs is deprecated: a single pg.Pool serves all users.
 *     Setting it emits a deprecation warning but does not fail.
 *   - Pool default max = 20 (pg.Pool default) — no --pg-pool-max flag yet.
 *
 * Issue: kytheros/strata#8
 * Design contract: project_pg_runtime_design_2026_05_10.md
 */

import { createServer as createHttpServer, type Server } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../server.js";
import type { HttpTransportHandle } from "./http-transport.js";
import { createPgStorage } from "../storage/pg/index.js";
import type { StorageContext } from "../storage/interfaces/index.js";

/** UUID v4 pattern for header validation */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Max concurrent MCP sessions per user — prevents session accumulation DoS */
const MAX_SESSIONS_PER_USER = 10;

// ── Auth-proxy support (mirrors SQLite transport) ─────────────────────────────

interface AuthProxyConfig {
  required: boolean;
  token: string | null;
}

function resolveAuthProxyConfig(): AuthProxyConfig {
  const required = process.env.STRATA_REQUIRE_AUTH_PROXY === "1";
  if (!required) return { required: false, token: null };

  const token = process.env.STRATA_AUTH_PROXY_TOKEN ?? "";
  if (!token) {
    throw new Error(
      "STRATA_REQUIRE_AUTH_PROXY=1 but STRATA_AUTH_PROXY_TOKEN is unset. " +
      "Set STRATA_AUTH_PROXY_TOKEN to a strong random value (e.g. `openssl rand -hex 32`) " +
      "and configure the upstream proxy to send it as the X-Strata-Verified header."
    );
  }
  if (token.length < 32) {
    throw new Error(
      "STRATA_AUTH_PROXY_TOKEN must be at least 32 characters for useful entropy."
    );
  }
  return { required: true, token };
}

function verifiedHeaderMatches(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface PgMultiTenantHttpTransportOptions {
  port: number;
  host?: string;
  /** Postgres connection string (DATABASE_URL). Required. */
  connectionString: string;
  /**
   * @deprecated maxDbs has no effect when DATABASE_URL is set — a single
   * pg.Pool serves all users with row-level scoping. Pass this only if
   * migrating from the SQLite multi-tenant transport; a warning is emitted.
   */
  maxDbs?: number;
  idleTimeoutMs?: number;
}

// ── Per-user entry ────────────────────────────────────────────────────────────

interface PgUserEntry {
  userId: string;
  /** MCP server with Postgres-backed StorageContext injected. */
  mcpServer: ReturnType<typeof createServer>;
  /** StorageContext owns connection lifecycle for this user. */
  storage: StorageContext;
  transports: Map<string, StreamableHTTPServerTransport>;
  lastAccess: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

// ── Transport ─────────────────────────────────────────────────────────────────

/**
 * Start the Postgres-backed multi-tenant MCP server.
 *
 * Routes:
 *   GET  /health     -> liveness probe
 *   POST /mcp        -> MCP JSON-RPC (requires X-Strata-User: <UUID>)
 *   GET  /mcp        -> SSE stream for existing session
 *   DELETE /mcp      -> session termination
 */
export async function startPgMultiTenantHttpTransport(
  options: PgMultiTenantHttpTransportOptions
): Promise<HttpTransportHandle> {
  const {
    port,
    host = "0.0.0.0",
    connectionString,
    maxDbs,
    idleTimeoutMs = 300_000,
  } = options;

  // Deprecation warning: --max-dbs is meaningless with pg (single pool, row-level scoping)
  if (maxDbs !== undefined) {
    console.warn(
      "[strata] --max-dbs is deprecated when DATABASE_URL is set. " +
      "A single pg.Pool serves all users via row-level scoping. " +
      "The value is ignored. Remove --max-dbs from your deployment config."
    );
  }

  const authProxy = resolveAuthProxyConfig();

  // ── User cache ────────────────────────────────────────────────────────
  // Unlike the SQLite transport, we do NOT need an LRU database-count limit —
  // all users share a single pg.Pool. We still maintain an in-memory user
  // map for session routing and idle-eviction of MCP transport objects.
  const users = new Map<string, PgUserEntry>();

  // Map mcp-session-id -> { userId, transport }
  const sessionIndex = new Map<
    string,
    { userId: string; transport: StreamableHTTPServerTransport }
  >();

  /**
   * Create a fresh MCP server for a user, backed by Postgres StorageContext.
   * Each user gets their own pg.Pool so that `storage.close()` ends their
   * connections independently on eviction.
   */
  async function createPgUserServer(
    userId: string
  ): Promise<{ mcpServer: ReturnType<typeof createServer>; storage: StorageContext }> {
    const storage = await createPgStorage({
      connectionString,
      userId,
    });
    const mcpServer = createServer({ storage });
    return { mcpServer, storage };
  }

  async function evictUser(userId: string): Promise<void> {
    const entry = users.get(userId);
    if (!entry) return;

    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }

    for (const [sid, transport] of entry.transports) {
      try {
        await transport.close();
      } catch {
        // ignore cleanup errors
      }
      sessionIndex.delete(sid);
    }
    entry.transports.clear();

    try {
      await entry.storage.close();
    } catch {
      // ignore close errors
    }

    users.delete(userId);
  }

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

  async function acquireUser(userId: string): Promise<PgUserEntry> {
    const existing = users.get(userId);
    if (existing) {
      if (existing.idleTimer) {
        clearTimeout(existing.idleTimer);
        existing.idleTimer = null;
      }
      existing.lastAccess = Date.now();
      // LRU promotion
      users.delete(userId);
      users.set(userId, existing);
      return existing;
    }

    const { mcpServer, storage } = await createPgUserServer(userId);

    const entry: PgUserEntry = {
      userId,
      mcpServer,
      storage,
      transports: new Map(),
      lastAccess: Date.now(),
      idleTimer: null,
    };

    users.set(userId, entry);
    return entry;
  }

  // ── HTTP server ───────────────────────────────────────────────────────

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (url.pathname === "/mcp") {
      try {
        await handleMcpRequest(req, res);
      } catch (error) {
        console.error(
          "[pg-multi-tenant] Error handling MCP request:",
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

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  async function handleMcpRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse
  ): Promise<void> {
    if (authProxy.required) {
      const presented = req.headers["x-strata-verified"] as string | undefined;
      if (!verifiedHeaderMatches(presented, authProxy.token!)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Missing or invalid X-Strata-Verified header" },
            id: null,
          })
        );
        return;
      }
    }

    const method = req.method?.toUpperCase();

    if (method === "POST") {
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      const mcpSessionId = req.headers["mcp-session-id"] as string | undefined;

      // ── Existing session routing ─────────────────────────────────────
      if (mcpSessionId) {
        const sessionEntry = sessionIndex.get(mcpSessionId);
        if (sessionEntry) {
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

      // ── New session ──────────────────────────────────────────────────
      const userId = req.headers["x-strata-user"] as string | undefined;

      if (!userId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Missing X-Strata-User header" },
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
            error: { code: -32000, message: "Invalid X-Strata-User header: must be UUID format" },
            id: parsed?.id ?? null,
          })
        );
        return;
      }

      if (!isInitializeRequest(parsed)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: No valid session ID provided" },
            id: parsed?.id ?? null,
          })
        );
        return;
      }

      // ── Initialize new pg-backed session ─────────────────────────────
      const userEntry = await acquireUser(userId);

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
      console.log(`Strata pg multi-tenant MCP server listening on ${host}:${port}`);
      console.log(`  Health: http://${host}:${port}/health`);
      console.log(`  MCP:    http://${host}:${port}/mcp`);
      console.log(`  Mode:   pg-multi-tenant (pool max: 20, DATABASE_URL configured)`);

      const handle: HttpTransportHandle = {
        server: httpServer,
        port,
        close: async () => {
          // Evict all users (closes transports + pg pool for each user)
          const userIds = [...users.keys()];
          for (const userId of userIds) {
            await evictUser(userId);
          }

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
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
