import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { resolveAuthProxyConfig } from "../../src/transports/multi-tenant-http-transport.js";

describe("resolveAuthProxyConfig insecure-mode warning", () => {
  const prev = process.env.STRATA_REQUIRE_AUTH_PROXY;
  beforeEach(() => { delete process.env.STRATA_REQUIRE_AUTH_PROXY; });
  afterEach(() => {
    if (prev === undefined) delete process.env.STRATA_REQUIRE_AUTH_PROXY;
    else process.env.STRATA_REQUIRE_AUTH_PROXY = prev;
    vi.restoreAllMocks();
  });

  it("warns when auth-proxy enforcement is not enabled", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cfg = resolveAuthProxyConfig();
    expect(cfg.required).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/X-Strata-User.*trust/i);
  });

  it("does NOT warn when enforcement is enabled", () => {
    process.env.STRATA_REQUIRE_AUTH_PROXY = "1";
    process.env.STRATA_AUTH_PROXY_TOKEN = "a".repeat(32);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cfg = resolveAuthProxyConfig();
    expect(cfg.required).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    delete process.env.STRATA_AUTH_PROXY_TOKEN;
  });
});
