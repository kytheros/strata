/**
 * RED test: single shared pg.Pool contract in pg-multi-tenant transport.
 *
 * The design contract (project_pg_runtime_design_2026_05_10.md, item 3) requires
 * a single pg.Pool per transport process — not one pool per user. The current
 * per-user-pool implementation:
 *   - Creates 20 connections per user (default pool max)
 *   - Cloud SQL Sandbox cap: 25 total connections
 *   - Result: 1 user saturates 80%, 2 users overflow
 *
 * This test asserts the contract by mocking the pg layer and counting Pool
 * constructor calls. It must FAIL on the current per-user-pool code and
 * PASS after the fix (pool created once per transport, not per user).
 *
 * Also asserts that evicting a user does NOT end the pool — the pool should
 * remain alive for the transport's full lifetime.
 *
 * Issue: kytheros/strata#8
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// ── Mock pg so Pool construction doesn't require a real database ──────────────

// We intercept createPool (the Strata wrapper) and createSchema/createPgStorage
// so the transport can start without any real Postgres connection.

// Track how many times createPool is called
let poolCreateCount = 0;

// Fake pool object returned by every createPool call
const fakeQueryFn = vi.fn().mockResolvedValue({ rows: [] });
const fakePool = {
  query: fakeQueryFn,
  connect: vi.fn().mockResolvedValue({
    query: fakeQueryFn,
    release: vi.fn(),
  }),
  end: vi.fn().mockResolvedValue(undefined),
  ended: false,
};

vi.mock("../../src/storage/pg/pg-types.js", () => ({
  createPool: vi.fn(() => {
    poolCreateCount++;
    return fakePool;
  }),
}));

vi.mock("../../src/storage/pg/schema.js", () => ({
  createSchema: vi.fn().mockResolvedValue(undefined),
  PG_SCHEMA_VERSION: "1",
  dropSchema: vi.fn().mockResolvedValue(undefined),
}));

// createPgStorage returns a minimal StorageContext per user (shared pool, different userId)
const storageCloseCount: Record<string, number> = {};
vi.mock("../../src/storage/pg/index.js", () => ({
  createPgStorage: vi.fn(async (opts: { pool?: unknown; connectionString?: string; userId: string }) => {
    const uid = opts.userId;
    storageCloseCount[uid] = 0;
    return {
      knowledge: { addEntry: vi.fn(), search: vi.fn().mockResolvedValue([]) } as unknown,
      documents: {} as unknown,
      entities: {} as unknown,
      summaries: {} as unknown,
      meta: {} as unknown,
      close: vi.fn(async () => {
        storageCloseCount[uid]++;
        // Pool end should NOT be called here in the shared-pool implementation
        // (fakePool.end is the sentinel we check)
      }),
    };
  }),
}));

// ── Import transport AFTER mocks are set up ───────────────────────────────────

import { startPgMultiTenantHttpTransport } from "../../src/transports/pg-multi-tenant-http-transport.js";
import type { HttpTransportHandle } from "../../src/transports/http-transport.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_PORT = 13201;
const UUID_A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaac";
const UUID_B = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbb1";

async function initSession(baseUrl: string, userId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/mcp`, {
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
        clientInfo: { name: "pool-contract-test", version: "1.0.0" },
      },
    }),
  });
  await res.text();
  return res.headers.get("mcp-session-id") ?? "";
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe.skipIf(process.platform === "win32")(
  "pg-multi-tenant transport — single shared pool contract",
  () => {
    let handle: HttpTransportHandle | undefined;

    afterEach(async () => {
      if (handle) {
        await handle.close().catch(() => {});
        handle = undefined;
      }
      poolCreateCount = 0;
      vi.clearAllMocks();
    });

    it("creates exactly one pg.Pool per transport process (not per user)", async () => {
      // FAILS on current per-user-pool code:
      //   poolCreateCount will be 2 after two users, not 1.
      handle = await startPgMultiTenantHttpTransport({
        port: BASE_PORT,
        connectionString: "postgresql://fake:fake@localhost:5432/fake",
      });

      expect(poolCreateCount).toBe(1); // pool created at transport startup

      // Trigger user acquisition for two different users
      await initSession(`http://localhost:${BASE_PORT}`, UUID_A);
      await initSession(`http://localhost:${BASE_PORT}`, UUID_B);

      // Still only one pool — both users share it
      expect(poolCreateCount).toBe(1);
    });

    it("evicting a user does NOT end the shared pool", async () => {
      handle = await startPgMultiTenantHttpTransport({
        port: BASE_PORT + 1,
        connectionString: "postgresql://fake:fake@localhost:5432/fake",
        idleTimeoutMs: 50, // short timeout so eviction fires quickly in test
      });

      await initSession(`http://localhost:${BASE_PORT + 1}`, UUID_A);

      // Wait for idle eviction to fire
      await new Promise((r) => setTimeout(r, 200));

      // pool.end() must NOT have been called — pool outlives individual users
      expect(fakePool.end).not.toHaveBeenCalled();
    });

    it("ends the shared pool exactly once on handle.close()", async () => {
      handle = await startPgMultiTenantHttpTransport({
        port: BASE_PORT + 2,
        connectionString: "postgresql://fake:fake@localhost:5432/fake",
      });

      await initSession(`http://localhost:${BASE_PORT + 2}`, UUID_A);
      await initSession(`http://localhost:${BASE_PORT + 2}`, UUID_B);

      await handle.close();
      handle = undefined;

      expect(fakePool.end).toHaveBeenCalledTimes(1);
    });
  }
);
