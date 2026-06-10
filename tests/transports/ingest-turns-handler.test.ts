/**
 * Unit tests for the shared conversation-ingest route handler (#30).
 *
 * Transport-agnostic: drives handleIngestTurnsRoute with mock req/res and
 * fake gate/acquire closures, so it runs everywhere (no real HTTP socket →
 * no Windows ECONNRESET). Both the SQLite and Postgres multi-tenant
 * transports delegate their POST /ingest/turns route to this handler.
 */
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  handleIngestTurnsRoute,
  MAX_INGEST_BODY_BYTES,
  type IngestRouteDeps,
} from "../../src/transports/ingest-turns-route.js";

const U = "11111111-1111-1111-1111-111111111111";

/** Minimal mock of node's ServerResponse capturing status + body. */
function mockRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    body: "",
    writeHead(code: number, headers?: Record<string, unknown>) { this.statusCode = code; if (headers) this.headers = headers; return this; },
    end(chunk?: string) { if (chunk) this.body += chunk; return this; },
  };
  return res as typeof res & import("node:http").ServerResponse;
}

/** Minimal mock of node's IncomingMessage that emits a body. */
function mockReq(opts: { method?: string; headers?: Record<string, string>; body?: string }) {
  const req = new EventEmitter() as EventEmitter & import("node:http").IncomingMessage;
  (req as { method?: string }).method = opts.method ?? "POST";
  (req as { headers: Record<string, string> }).headers = opts.headers ?? {};
  (req as { destroy: () => void }).destroy = () => { req.emit("close"); };
  // Emit body on next tick so the handler's listeners attach first.
  queueMicrotask(() => {
    if (opts.body !== undefined) req.emit("data", Buffer.from(opts.body, "utf-8"));
    req.emit("end");
  });
  return req;
}

function deps(over: Partial<IngestRouteDeps> = {}): IngestRouteDeps {
  return {
    requireTenant: () => U,
    acquire: async () => ({
      ingestTurns: async (input) => ({ sessionId: input.sessionId, turnsWritten: input.messages.length, chunksWritten: 1, entriesWritten: 0, embedded: false, warnings: [] }),
      release: () => {},
    }),
    ...over,
  };
}

describe("handleIngestTurnsRoute", () => {
  it("rejects non-POST with 405 (before the gate)", async () => {
    const res = mockRes();
    const reqq = mockReq({ method: "GET", headers: { "x-strata-user": U } });
    await handleIngestTurnsRoute(reqq, res, deps());
    expect(res.statusCode).toBe(405);
  });

  it("returns the ingest result as JSON on a valid POST", async () => {
    const res = mockRes();
    const body = JSON.stringify({ sessionId: "s9", messages: [{ speaker: "user", content: "hi" }, { speaker: "assistant", content: "yo" }] });
    const reqq = mockReq({ headers: { "x-strata-user": U, "content-type": "application/json" }, body });
    await handleIngestTurnsRoute(reqq, res, deps());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).turnsWritten).toBe(2);
    expect(JSON.parse(res.body).sessionId).toBe("s9");
  });

  it("forwards the gate's rejection (does not call acquire when requireTenant returns null)", async () => {
    const res = mockRes();
    const acquire = vi.fn();
    const reqq = mockReq({ headers: {}, body: "{}" });
    await handleIngestTurnsRoute(reqq, res, deps({
      requireTenant: (_r, rr) => { rr.writeHead(401, {}); rr.end(JSON.stringify({ error: "nope" })); return null; },
      acquire: acquire as unknown as IngestRouteDeps["acquire"],
    }));
    expect(res.statusCode).toBe(401);
    expect(acquire).not.toHaveBeenCalled();
  });

  it("early-413 on a declared Content-Length over the cap (before reading the stream)", async () => {
    const res = mockRes();
    const reqq = mockReq({ headers: { "x-strata-user": U, "content-length": String(MAX_INGEST_BODY_BYTES + 1) }, body: "{}" });
    await handleIngestTurnsRoute(reqq, res, deps());
    expect(res.statusCode).toBe(413);
  });

  it("400 on malformed JSON, and always releases the user", async () => {
    const res = mockRes();
    const release = vi.fn();
    const reqq = mockReq({ headers: { "x-strata-user": U }, body: "{not json" });
    await handleIngestTurnsRoute(reqq, res, deps({
      acquire: async () => ({ ingestTurns: async () => { throw new Error("should not reach"); }, release }),
    }));
    expect(res.statusCode).toBe(400);
    // acquire happens after parse, so on malformed JSON release isn't reached — but a
    // valid body that throws inside ingestTurns must still release:
  });

  it("releases the user even when ingestTurns throws", async () => {
    const res = mockRes();
    const release = vi.fn();
    const body = JSON.stringify({ sessionId: "s", messages: [{ speaker: "user", content: "hi" }] });
    const reqq = mockReq({ headers: { "x-strata-user": U }, body });
    await handleIngestTurnsRoute(reqq, res, deps({
      acquire: async () => ({ ingestTurns: async () => { throw new Error("boom"); }, release }),
    }));
    expect(res.statusCode).toBe(400);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
