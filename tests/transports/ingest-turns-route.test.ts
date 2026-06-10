import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startMultiTenantHttpTransport } from "../../src/transports/multi-tenant-http-transport.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const U = "11111111-1111-1111-1111-111111111111";
let handle: Awaited<ReturnType<typeof startMultiTenantHttpTransport>>;
const base = mkdtempSync(join(tmpdir(), "ingest-rt-"));

// Pin the dense-turn-lane kill-switch to its default (ON) before any transport is
// created — the per-user server reads STRATA_DENSE_TURN_LANE live, so a sibling test
// file leaving it "off" in the shared worker would make ingest write 0 turns.
const savedDTL = process.env.STRATA_DENSE_TURN_LANE;
beforeAll(() => { delete process.env.STRATA_DENSE_TURN_LANE; });

async function start(port: number) {
  handle = await startMultiTenantHttpTransport({ port, baseDir: base });
  return `http://127.0.0.1:${port}`;
}
afterAll(async () => { await handle?.close?.(); if (savedDTL === undefined) delete process.env.STRATA_DENSE_TURN_LANE; else process.env.STRATA_DENSE_TURN_LANE = savedDTL; });

describe("POST /ingest/turns", () => {
  it("rejects a non-UUID X-Strata-User with 400 before touching any tenant DB", async () => {
    const url = await start(34101);
    const r = await fetch(`${url}/ingest/turns`, { method: "POST",
      headers: { "content-type": "application/json", "x-strata-user": "not-a-uuid" },
      body: JSON.stringify({ sessionId: "s", messages: [{ speaker: "user", content: "hi" }] }) });
    expect(r.status).toBe(400);
  });

  it("writes turns for a valid tenant and returns the result", async () => {
    const url = `http://127.0.0.1:34101`;
    const r = await fetch(`${url}/ingest/turns`, { method: "POST",
      headers: { "content-type": "application/json", "x-strata-user": U },
      body: JSON.stringify({ sessionId: "sess-9", messages: [
        { speaker: "user", content: "what port does the api use" },
        { speaker: "assistant", content: "the api listens on 8080" },
      ]}) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.turnsWritten).toBe(2);
    expect(body.sessionId).toBe("sess-9");
  });

  it("rejects non-POST with 405", async () => {
    const url = `http://127.0.0.1:34101`;
    const r = await fetch(`${url}/ingest/turns`, { method: "GET", headers: { "x-strata-user": U } });
    expect(r.status).toBe(405);
  });

  it("rejects a body over the 5 MB cap with 413 (before opening a tenant DB)", async () => {
    const url = `http://127.0.0.1:34101`;
    const huge = "x".repeat(6 * 1024 * 1024); // 6 MB > 5 MB cap
    const r = await fetch(`${url}/ingest/turns`, { method: "POST",
      headers: { "content-type": "application/json", "x-strata-user": U },
      body: JSON.stringify({ sessionId: "big", messages: [{ speaker: "user", content: huge }] }) });
    expect(r.status).toBe(413);
  });

  it("with STRATA_REQUIRE_AUTH_PROXY=1, gates on X-Strata-Verified (401 on missing/wrong, 200 on correct) before any tenant DB", async () => {
    const TOKEN = "a".repeat(64); // >= 32 chars required by resolveAuthProxyConfig
    const savedReq = process.env.STRATA_REQUIRE_AUTH_PROXY;
    const savedTok = process.env.STRATA_AUTH_PROXY_TOKEN;
    process.env.STRATA_REQUIRE_AUTH_PROXY = "1";
    process.env.STRATA_AUTH_PROXY_TOKEN = TOKEN;
    const base2 = mkdtempSync(join(tmpdir(), "ingest-rt-auth-"));
    const h2 = await startMultiTenantHttpTransport({ port: 34102, baseDir: base2 });
    const url = "http://127.0.0.1:34102";
    const payload = JSON.stringify({ sessionId: "s", messages: [{ speaker: "user", content: "hi" }] });
    try {
      const missing = await fetch(`${url}/ingest/turns`, { method: "POST",
        headers: { "content-type": "application/json", "x-strata-user": U }, body: payload });
      expect(missing.status).toBe(401);

      const wrong = await fetch(`${url}/ingest/turns`, { method: "POST",
        headers: { "content-type": "application/json", "x-strata-user": U, "x-strata-verified": "b".repeat(64) }, body: payload });
      expect(wrong.status).toBe(401);

      const ok = await fetch(`${url}/ingest/turns`, { method: "POST",
        headers: { "content-type": "application/json", "x-strata-user": U, "x-strata-verified": TOKEN },
        body: JSON.stringify({ sessionId: "ok", messages: [{ speaker: "user", content: "hi" }] }) });
      expect(ok.status).toBe(200);
    } finally {
      await h2?.close?.();
      if (savedReq === undefined) delete process.env.STRATA_REQUIRE_AUTH_PROXY; else process.env.STRATA_REQUIRE_AUTH_PROXY = savedReq;
      if (savedTok === undefined) delete process.env.STRATA_AUTH_PROXY_TOKEN; else process.env.STRATA_AUTH_PROXY_TOKEN = savedTok;
    }
  });
});
