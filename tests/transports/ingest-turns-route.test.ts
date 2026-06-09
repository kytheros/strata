import { describe, it, expect, afterAll } from "vitest";
import { startMultiTenantHttpTransport } from "../../src/transports/multi-tenant-http-transport.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const U = "11111111-1111-1111-1111-111111111111";
let handle: Awaited<ReturnType<typeof startMultiTenantHttpTransport>>;
const base = mkdtempSync(join(tmpdir(), "ingest-rt-"));

async function start(port: number) {
  handle = await startMultiTenantHttpTransport({ port, baseDir: base });
  return `http://127.0.0.1:${port}`;
}
afterAll(async () => { await handle?.close?.(); });

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
});
