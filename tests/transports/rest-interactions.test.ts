import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRestTransport } from "../../src/transports/rest-transport.js";
import type { RestTransportHandle } from "../../src/transports/rest-transport.js";

async function post(
  port: number,
  path: string,
  body: unknown
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const status = res.status;
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status, json };
}

describe("POST /api/interactions — contract", () => {
  let dataDir: string;
  let transport: RestTransportHandle;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "rest-int-"));
    transport = await startRestTransport({ port: 0, host: "127.0.0.1", baseDir: dataDir });
  });

  afterEach(async () => {
    await transport.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns 400 when npcA === npcB", async () => {
    const r = await post(transport.port, "/api/interactions", {
      npcA: "goran",
      npcB: "goran",
    });
    expect(r.status).toBe(400);
  });

  it("returns 400 when npcA or npcB is missing", async () => {
    const r = await post(transport.port, "/api/interactions", { npcA: "goran" });
    expect(r.status).toBe(400);
  });

  it("returns 200 with empty disclosures and a seed when both NPCs exist but have no profiles", async () => {
    const r = await post(transport.port, "/api/interactions", {
      npcA: "goran",
      npcB: "brynn",
    });
    expect(r.status).toBe(200);
    expect(r.json).not.toBeNull();
    expect(r.json!.disclosures).toEqual([]);
    expect(typeof r.json!.seed).toBe("number");
  });

  it("echoes the provided seed when one is supplied", async () => {
    const r = await post(transport.port, "/api/interactions", {
      npcA: "goran",
      npcB: "brynn",
      seed: 999,
    });
    expect(r.json!.seed).toBe(999);
  });
});
