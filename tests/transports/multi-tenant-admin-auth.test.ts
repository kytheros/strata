import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  startMultiTenantHttpTransport,
} from "../../src/transports/multi-tenant-http-transport.js";
import type { HttpTransportHandle } from "../../src/transports/http-transport.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let handle: HttpTransportHandle | undefined;
let baseUrl: string;

function getBaseUrl(handle: HttpTransportHandle): string {
  const addr = handle.server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("No address");
  return `http://127.0.0.1:${addr.port}`;
}

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = undefined;
  }
  // Clean up the env var after each test
  delete process.env.STRATA_ADMIN_TOKEN;
});

describe("/admin/pool authentication", () => {
  it("should return 404 when STRATA_ADMIN_TOKEN is not set", async () => {
    delete process.env.STRATA_ADMIN_TOKEN;

    const tempDir = mkdtempSync(join(tmpdir(), "strata-mt-test-"));
    handle = await startMultiTenantHttpTransport({
      port: 0,
      baseDir: tempDir,
    });
    baseUrl = getBaseUrl(handle);

    const res = await fetch(`${baseUrl}/admin/pool`);
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe("Not found");
  });

  it("should return 401 when Authorization header is missing", async () => {
    process.env.STRATA_ADMIN_TOKEN = "test-secret-token";

    const tempDir = mkdtempSync(join(tmpdir(), "strata-mt-test-"));
    handle = await startMultiTenantHttpTransport({
      port: 0,
      baseDir: tempDir,
    });
    baseUrl = getBaseUrl(handle);

    const res = await fetch(`${baseUrl}/admin/pool`);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("should return 403 when token is invalid", async () => {
    process.env.STRATA_ADMIN_TOKEN = "test-secret-token";

    const tempDir = mkdtempSync(join(tmpdir(), "strata-mt-test-"));
    handle = await startMultiTenantHttpTransport({
      port: 0,
      baseDir: tempDir,
    });
    baseUrl = getBaseUrl(handle);

    const res = await fetch(`${baseUrl}/admin/pool`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toBe("Forbidden");
  });

  it("should return 403 when auth scheme is not Bearer", async () => {
    process.env.STRATA_ADMIN_TOKEN = "test-secret-token";

    const tempDir = mkdtempSync(join(tmpdir(), "strata-mt-test-"));
    handle = await startMultiTenantHttpTransport({
      port: 0,
      baseDir: tempDir,
    });
    baseUrl = getBaseUrl(handle);

    const res = await fetch(`${baseUrl}/admin/pool`, {
      headers: { Authorization: "Basic test-secret-token" },
    });
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toBe("Forbidden");
  });

  it("should return 200 with pool entries when token is valid", async () => {
    process.env.STRATA_ADMIN_TOKEN = "test-secret-token";

    const tempDir = mkdtempSync(join(tmpdir(), "strata-mt-test-"));
    handle = await startMultiTenantHttpTransport({
      port: 0,
      baseDir: tempDir,
    });
    baseUrl = getBaseUrl(handle);

    const res = await fetch(`${baseUrl}/admin/pool`, {
      headers: { Authorization: "Bearer test-secret-token" },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty("entries");
    expect(Array.isArray(body.entries)).toBe(true);
  });

  it("should return full pool stats payload when token is valid", async () => {
    process.env.STRATA_ADMIN_TOKEN = "test-secret-token";

    const tempDir = mkdtempSync(join(tmpdir(), "strata-mt-test-"));
    handle = await startMultiTenantHttpTransport({
      port: 0,
      baseDir: tempDir,
    });
    baseUrl = getBaseUrl(handle);

    const res = await fetch(`${baseUrl}/admin/pool`, {
      headers: { Authorization: "Bearer test-secret-token" },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    // Must include the pool stats fields that used to leak on /health
    expect(body).toHaveProperty("open");
    expect(body).toHaveProperty("maxOpen");
    expect(body).toHaveProperty("hits");
    expect(body).toHaveProperty("misses");
    expect(body).toHaveProperty("hitRate");
    expect(body).toHaveProperty("uptime");
    expect(typeof body.open).toBe("number");
    expect(typeof body.maxOpen).toBe("number");
    expect(typeof body.hits).toBe("number");
    expect(typeof body.misses).toBe("number");
    expect(typeof body.hitRate).toBe("string");
    expect(typeof body.uptime).toBe("number");
  });
});

describe("/health endpoint (multi-tenant)", () => {
  it("should return only {status:'ok'} with no pool internals — unauthenticated", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "strata-mt-test-"));
    handle = await startMultiTenantHttpTransport({
      port: 0,
      baseDir: tempDir,
    });
    baseUrl = getBaseUrl(handle);

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
    // Must NOT leak pool internals
    expect(body).not.toHaveProperty("mode");
    expect(body).not.toHaveProperty("pool");
    expect(body).not.toHaveProperty("uptime");
    expect(body).not.toHaveProperty("open");
    expect(body).not.toHaveProperty("hits");
    expect(body).not.toHaveProperty("misses");
  });

  it("should return only {status:'ok'} even when STRATA_ADMIN_TOKEN is set", async () => {
    process.env.STRATA_ADMIN_TOKEN = "test-secret-token";

    const tempDir = mkdtempSync(join(tmpdir(), "strata-mt-test-"));
    handle = await startMultiTenantHttpTransport({
      port: 0,
      baseDir: tempDir,
    });
    baseUrl = getBaseUrl(handle);

    const res = await fetch(`${baseUrl}/health`, {
      headers: { Authorization: "Bearer test-secret-token" },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });
});
