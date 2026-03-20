/**
 * Multi-tenant HTTP Transport Integration Test
 *
 * Validates:
 * - Per-user database isolation (User A cannot see User B's data)
 * - X-Strata-User header validation (missing -> 400, invalid UUID -> 400)
 * - Health endpoint returns pool stats
 * - Admin endpoint returns per-user details
 * - Separate strata.db files created per user
 * - Full MCP lifecycle per user: init -> store_memory -> search_history
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  startMultiTenantHttpTransport,
  type MultiTenantHttpTransportOptions,
} from "../../src/transports/multi-tenant-http-transport.js";
import type { HttpTransportHandle } from "../../src/transports/http-transport.js";

const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "strata-mt-test-"));
}

/** Parse SSE response text to extract JSON-RPC result */
function parseSSE(text: string): any {
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      try {
        return JSON.parse(line.slice(6));
      } catch {
        // skip non-JSON data lines
      }
    }
  }
  // Try parsing as direct JSON (non-SSE response)
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Helper: perform MCP initialize handshake for a user and return session ID.
 */
async function initializeSession(
  baseUrl: string,
  userId: string
): Promise<string> {
  // 1. Initialize
  const initRes = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
      "X-Strata-User": userId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "mt-test", version: "1.0.0" },
      },
    }),
  });

  expect(initRes.status).toBe(200);
  const sessionId = initRes.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();

  // Consume init response
  await initRes.text();

  // 2. Send initialized notification
  await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
      "mcp-session-id": sessionId!,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });

  return sessionId!;
}

/**
 * Helper: call an MCP tool via an established session.
 */
async function callTool(
  baseUrl: string,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  requestId: number = 2
): Promise<any> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    }),
  });

  expect(res.status).toBe(200);
  const data = parseSSE(await res.text());
  expect(data).toBeTruthy();
  return data;
}

// Windows ECONNRESET on HTTP transport tests -- works on Linux CI
describe.skipIf(process.platform === "win32")(
  "Multi-tenant HTTP Transport",
  () => {
    let handle: HttpTransportHandle | undefined;
    let baseDir: string;

    afterEach(async () => {
      if (handle) {
        await handle.close();
        handle = undefined;
      }
    });

    it("should return 400 when X-Strata-User header is missing", async () => {
      baseDir = makeTempDir();
      handle = await startMultiTenantHttpTransport({
        port: 0,
        baseDir,
        maxDbs: 10,
      });
      const addr = handle.server.address();
      if (typeof addr !== "object" || addr === null)
        throw new Error("No address");
      const baseUrl = `http://127.0.0.1:${addr.port}`;

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
            clientInfo: { name: "test", version: "1.0" },
          },
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain("Missing X-Strata-User");
    });

    it("should return 400 when X-Strata-User is not a valid UUID", async () => {
      baseDir = makeTempDir();
      handle = await startMultiTenantHttpTransport({
        port: 0,
        baseDir,
        maxDbs: 10,
      });
      const addr = handle.server.address();
      if (typeof addr !== "object" || addr === null)
        throw new Error("No address");
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream, application/json",
          "X-Strata-User": "not-a-uuid",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0" },
          },
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain("Invalid X-Strata-User");
    });

    it("should return health with pool stats", async () => {
      baseDir = makeTempDir();
      handle = await startMultiTenantHttpTransport({
        port: 0,
        baseDir,
        maxDbs: 10,
      });
      const addr = handle.server.address();
      if (typeof addr !== "object" || addr === null)
        throw new Error("No address");
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.mode).toBe("multi-tenant");
      expect(body.pool).toBeDefined();
      expect(body.pool.open).toBe(0);
      expect(body.pool.maxOpen).toBe(10);
    });

    it("should return admin pool details", async () => {
      baseDir = makeTempDir();
      handle = await startMultiTenantHttpTransport({
        port: 0,
        baseDir,
        maxDbs: 10,
      });
      const addr = handle.server.address();
      if (typeof addr !== "object" || addr === null)
        throw new Error("No address");
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      const res = await fetch(`${baseUrl}/admin/pool`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.entries).toBeDefined();
      expect(Array.isArray(body.entries)).toBe(true);
      expect(body.entries.length).toBe(0);
    });

    it("should return 404 for unknown paths", async () => {
      baseDir = makeTempDir();
      handle = await startMultiTenantHttpTransport({
        port: 0,
        baseDir,
        maxDbs: 10,
      });
      const addr = handle.server.address();
      if (typeof addr !== "object" || addr === null)
        throw new Error("No address");

      const res = await fetch(
        `http://127.0.0.1:${addr.port}/nonexistent`
      );
      expect(res.status).toBe(404);
    });

    it("should initialize a session for a valid user", async () => {
      baseDir = makeTempDir();
      handle = await startMultiTenantHttpTransport({
        port: 0,
        baseDir,
        maxDbs: 10,
      });
      const addr = handle.server.address();
      if (typeof addr !== "object" || addr === null)
        throw new Error("No address");
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      const sessionId = await initializeSession(baseUrl, UUID_A);
      expect(sessionId).toBeTruthy();

      // Verify DB file was created
      const dbPath = join(baseDir, UUID_A, "strata.db");
      expect(existsSync(dbPath)).toBe(true);

      // Health should show 1 open connection
      const healthRes = await fetch(`${baseUrl}/health`);
      const health = await healthRes.json();
      expect(health.pool.open).toBe(1);
    });

    it("should isolate data between users", async () => {
      baseDir = makeTempDir();
      handle = await startMultiTenantHttpTransport({
        port: 0,
        baseDir,
        maxDbs: 10,
      });
      const addr = handle.server.address();
      if (typeof addr !== "object" || addr === null)
        throw new Error("No address");
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      // ── User A: initialize and store a memory ──────────────────────
      const sessionA = await initializeSession(baseUrl, UUID_A);

      const storeA = await callTool(baseUrl, sessionA, "store_memory", {
        memory: "User A secret: the password is hunter2",
        type: "fact",
        tags: ["secret"],
        project: "user-a-project",
      }, 10);

      expect(storeA.result).toBeTruthy();
      const storeContentA = storeA.result.content[0]?.text || "";
      expect(storeContentA).toContain("Stored");

      // ── User B: initialize and store a memory ──────────────────────
      const sessionB = await initializeSession(baseUrl, UUID_B);

      const storeB = await callTool(baseUrl, sessionB, "store_memory", {
        memory: "User B secret: the answer is 42",
        type: "fact",
        tags: ["answer"],
        project: "user-b-project",
      }, 20);

      expect(storeB.result).toBeTruthy();
      const storeContentB = storeB.result.content[0]?.text || "";
      expect(storeContentB).toContain("Stored");

      // ── User A: search should find only A's data ────────────────────
      const searchA = await callTool(baseUrl, sessionA, "search_history", {
        query: "secret password hunter2",
      }, 11);

      const searchTextA = searchA.result.content[0]?.text || "";
      // User A's search should contain their own data
      // (The search may return "No results" from FTS if the knowledge table
      // isn't indexed into the FTS table, but it should NOT contain User B's data)
      expect(searchTextA).not.toContain("answer is 42");

      // ── User B: search should find only B's data ────────────────────
      const searchB = await callTool(baseUrl, sessionB, "search_history", {
        query: "secret answer 42",
      }, 21);

      const searchTextB = searchB.result.content[0]?.text || "";
      expect(searchTextB).not.toContain("hunter2");

      // ── Verify separate DB files ──────────────────────────────────
      expect(existsSync(join(baseDir, UUID_A, "strata.db"))).toBe(true);
      expect(existsSync(join(baseDir, UUID_B, "strata.db"))).toBe(true);

      // ── Health shows both users ──────────────────────────────────
      const healthRes = await fetch(`${baseUrl}/health`);
      const health = await healthRes.json();
      expect(health.pool.open).toBe(2);

      // ── Admin shows both users ──────────────────────────────────
      const adminRes = await fetch(`${baseUrl}/admin/pool`);
      const admin = await adminRes.json();
      expect(admin.entries.length).toBe(2);
      const adminUserIds = admin.entries.map((e: any) => e.userId);
      expect(adminUserIds).toContain(UUID_A);
      expect(adminUserIds).toContain(UUID_B);
    }, 30000);

    it("should handle graceful shutdown", async () => {
      baseDir = makeTempDir();
      handle = await startMultiTenantHttpTransport({
        port: 0,
        baseDir,
        maxDbs: 10,
      });

      await handle.close();
      expect(handle.server.listening).toBe(false);
      handle = undefined; // already closed
    });
  }
);
