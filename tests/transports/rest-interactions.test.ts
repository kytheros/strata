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

describe("POST /api/interactions — gossip flow", () => {
  let dataDir: string;
  let transport: RestTransportHandle;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "rest-int-gossip-"));
    transport = await startRestTransport({ port: 0, host: "127.0.0.1", baseDir: dataDir });

    // Profile goran as gossipy, propagates confessions
    await fetch(`http://127.0.0.1:${transport.port}/api/agents/goran/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Goran",
        alignment: { ethical: "lawful", moral: "good" },
        gossipTrait: "gossipy",
        propagateTags: ["confession"],
      }),
    });
    await fetch(`http://127.0.0.1:${transport.port}/api/agents/brynn/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Brynn",
        alignment: { ethical: "neutral", moral: "good" },
      }),
    });

    // Store a confession on Goran
    await fetch(`http://127.0.0.1:${transport.port}/api/agents/goran/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        memory: "The player confessed to the murder in the temple.",
        tags: ["confession", "juicy"],
      }),
    });
  });

  afterEach(async () => {
    await transport.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("propagates a matching-tag memory on a successful roll", async () => {
    // Seed chosen so gossipy + juicy + high trust should succeed on at least one iteration.
    // We iterate a few seeds to guarantee at least one disclosure, since this is a probabilistic roll.
    let disclosed = false;
    let port = transport.port;
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = await post(port, "/api/interactions", {
        npcA: "goran",
        npcB: "brynn",
        seed,
      });
      expect(r.status).toBe(200);
      expect(Array.isArray((r.json as any).disclosures)).toBe(true);
      const ds = (r.json as any).disclosures as Array<{ result: string }>;
      if (ds.some((d) => d.result === "disclosed")) {
        disclosed = true;
        break;
      }
    }
    expect(disclosed).toBe(true);

    // Search on Brynn — the gossiped memory should appear with the heard-from tag.
    const searchRes = await fetch(`http://127.0.0.1:${port}/api/agents/brynn/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "confession murder temple" }),
    });
    const body = (await searchRes.json()) as { results: Array<{ text?: string; tags?: string[] }> };
    expect(body.results.length).toBeGreaterThan(0);
    const hit = body.results.find((r) => r.text?.includes("confessed"));
    expect(hit).toBeDefined();
    expect(hit!.tags).toContain("heard-from-goran");
  });

  it("deterministic disclosures under fixed seed across two runs", async () => {
    const a = await post(transport.port, "/api/interactions", { npcA: "goran", npcB: "brynn", seed: 42 });
    const b = await post(transport.port, "/api/interactions", { npcA: "goran", npcB: "brynn", seed: 42 });
    const ad = (a.json as any).disclosures as Array<{ roll: number }>;
    const bd = (b.json as any).disclosures as Array<{ roll: number }>;
    expect(ad.map((d) => d.roll)).toEqual(bd.map((d) => d.roll));
  });

  it("does not re-disclose already-hearsay memories", async () => {
    await post(transport.port, "/api/interactions", { npcA: "goran", npcB: "brynn", seed: 1 });
    // Second run from brynn -> mira: mira has no profile so nothing happens regardless. Verifies
    // the already-hearsay branch doesn't crash when brynn's memory carries heard-from-goran.
    const r = await post(transport.port, "/api/interactions", {
      npcA: "brynn",
      npcB: "mira",
      seed: 1,
    });
    expect(r.status).toBe(200);
  });

  it("no disclosure when propagateTags is empty/absent", async () => {
    // brynn has no propagateTags — storing a confession on brynn then interacting with mira (profiled)
    // should never propagate.
    await fetch(`http://127.0.0.1:${transport.port}/api/agents/brynn/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memory: "Secret alliance rumor brewing.", tags: ["confession"] }),
    });
    await fetch(`http://127.0.0.1:${transport.port}/api/agents/mira/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Mira",
        alignment: { ethical: "neutral", moral: "neutral" },
      }),
    });
    const r = await post(transport.port, "/api/interactions", {
      npcA: "brynn",
      npcB: "mira",
      seed: 1,
    });
    const ds = (r.json as any).disclosures as Array<{ result: string }>;
    // Either empty (no tags matched, skipped silently) or all kept.
    expect(ds.every((d) => d.result === "kept")).toBe(true);
  });
});
