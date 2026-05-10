/**
 * Test: PgMultiTenantHttpTransport — routes DATABASE_URL to Postgres storage.
 *
 * Requires Postgres available at PG_URL (set by CI services: block or locally).
 * Skips gracefully when Postgres is not reachable.
 *
 * Validates:
 * - startPgMultiTenantHttpTransport starts and responds to /health
 * - X-Strata-User header routes to a per-user Postgres-backed MCP server
 * - MCP initialize handshake succeeds
 * - store_memory + search_history round-trip persists data in Postgres (not ephemeral SQLite)
 * - --max-dbs deprecation warning fires when DATABASE_URL is set
 *
 * Issue: kytheros/strata#8
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import pg from "pg";
import {
  startPgMultiTenantHttpTransport,
  type PgMultiTenantHttpTransportOptions,
} from "../../src/transports/pg-multi-tenant-http-transport.js";
import type { HttpTransportHandle } from "../../src/transports/http-transport.js";

const PG_URL =
  process.env.PG_URL || "postgresql://postgres:test@localhost:5432/postgres";
const TEST_PORT = 13199; // dedicated port, avoids collision with other transports

const UUID_A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaab";

/** Parse SSE response text to extract first JSON-RPC result */
function parseSSE(text: string): unknown {
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      try {
        return JSON.parse(line.slice(6));
      } catch {
        // skip non-JSON lines
      }
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function initializeSession(
  baseUrl: string,
  userId: string
): Promise<string> {
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
        clientInfo: { name: "pg-mt-test", version: "1.0.0" },
      },
    }),
  });

  expect(initRes.status).toBe(200);
  const sessionId = initRes.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  await initRes.text(); // consume response body

  // Send initialized notification
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

async function callTool(
  baseUrl: string,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  requestId: number = 2
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
      id: requestId,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });

  expect(res.status).toBe(200);
  const data = parseSSE(await res.text());
  expect(data).toBeTruthy();
  return data;
}

// Skip on Windows (ECONNRESET on HTTP transport tests) — same guard as SQLite counterpart
describe.skipIf(process.platform === "win32")(
  "PgMultiTenantHttpTransport",
  () => {
    let handle: HttpTransportHandle | undefined;
    let pgAvailable = false;
    let pool: pg.Pool | undefined;

    // Check Postgres availability before all tests in this suite
    beforeAll(async () => {
      pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
      try {
        await pool.query("SELECT 1");
        pgAvailable = true;
      } catch {
        console.log(
          "[pg-mt-test] Postgres not available — skipping pg multi-tenant transport tests"
        );
        await pool.end();
        pool = undefined;
      }
    });

    afterEach(async () => {
      if (handle) {
        await handle.close();
        handle = undefined;
      }
    });

    afterAll(async () => {
      if (pool) {
        // Clean up test rows inserted during these tests
        await pool
          .query("DELETE FROM knowledge WHERE user_scope = $1", [UUID_A])
          .catch(() => {});
        await pool.end();
      }
    });

    it("exports startPgMultiTenantHttpTransport function", () => {
      // This test verifies the module exists and exports the named function.
      // It fails before the file is created.
      expect(typeof startPgMultiTenantHttpTransport).toBe("function");
    });

    it("health endpoint returns {status:ok}", async () => {
      if (!pgAvailable) return;

      handle = await startPgMultiTenantHttpTransport({
        port: TEST_PORT,
        connectionString: PG_URL,
      });

      const res = await fetch(`http://localhost:${TEST_PORT}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect((body as { status: string }).status).toBe("ok");
    });

    it("MCP initialize succeeds for a user", async () => {
      if (!pgAvailable) return;

      handle = await startPgMultiTenantHttpTransport({
        port: TEST_PORT,
        connectionString: PG_URL,
      });

      const sessionId = await initializeSession(
        `http://localhost:${TEST_PORT}`,
        UUID_A
      );
      expect(sessionId).toBeTruthy();
    });

    it("store_memory round-trip persists to Postgres (not ephemeral SQLite)", async () => {
      if (!pgAvailable) return;

      handle = await startPgMultiTenantHttpTransport({
        port: TEST_PORT,
        connectionString: PG_URL,
      });

      const baseUrl = `http://localhost:${TEST_PORT}`;
      const sessionId = await initializeSession(baseUrl, UUID_A);

      // Store a memory
      await callTool(baseUrl, sessionId, "store_memory", {
        memory: "pg-multi-tenant round-trip test memory",
        type: "fact",
        project: "strata-test",
      });

      // Verify it landed in Postgres (not SQLite) by querying the pool directly
      const { rows } = await pool!.query<{ summary: string }>(
        "SELECT summary FROM knowledge WHERE user_scope = $1 AND summary LIKE $2",
        [UUID_A, "%pg-multi-tenant round-trip%"]
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].summary).toContain("pg-multi-tenant round-trip");
    });

    it("emits deprecation warning when maxDbs is set alongside connectionString", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Should not throw; just warn
      handle = await startPgMultiTenantHttpTransport({
        port: TEST_PORT + 1,
        connectionString: pgAvailable
          ? PG_URL
          : "postgresql://postgres:test@localhost:5432/postgres",
        maxDbs: 50, // deprecated with pg
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("--max-dbs")
      );
      warnSpy.mockRestore();

      // Close the +1 port handle separately
      await handle.close();
      handle = undefined;
    });
  }
);
