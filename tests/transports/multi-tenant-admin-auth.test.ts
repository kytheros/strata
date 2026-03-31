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
});
