/**
 * Co-op integration test — two players sharing one world.
 *
 * Scenario: PC1 and PC2 are provisioned into "coop-1".
 *   - NPC memories (store/recall/search) are world-scoped: PC1 stores → PC2 recalls.
 *   - Relationships are per-player: PC1's trust update does not affect PC2.
 *   - Gossip (POST /api/interactions) writes to world.db; both players see the result.
 *
 * All requests use v2 player tokens (strata_v2.* HMAC) issued with worldId="coop-1".
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRestTransport } from "../../src/transports/rest-transport.js";
import type { RestTransportHandle } from "../../src/transports/rest-transport.js";

const ADMIN_TOKEN = "a".repeat(32);

let dataDir: string;
let transport: RestTransportHandle;
let baseUrl: string;

/** Typed fetch helper — returns { status, body }. */
async function api(
  method: string,
  path: string,
  body: unknown,
  token?: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: method !== "GET" ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: json };
}

/** Provision a player into a world, return v2 token. */
async function provisionPlayer(worldId: string): Promise<string> {
  const r = await api("POST", "/api/players", {}, ADMIN_TOKEN);
  // Second call with X-Strata-World header
  const res = await fetch(`${baseUrl}/api/players`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ADMIN_TOKEN}`,
      "X-Strata-World": worldId,
    },
    body: JSON.stringify({}),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (typeof data.playerToken !== "string") {
    throw new Error(`provisionPlayer failed: ${JSON.stringify(data)}`);
  }
  return data.playerToken as string;
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "strata-coop-"));
  transport = await startRestTransport({
    port: 0,
    host: "127.0.0.1",
    token: ADMIN_TOKEN,
    baseDir: dataDir,
  });
  const addr = transport.server.address();
  if (typeof addr !== "object" || !addr) throw new Error("No address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await transport.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("world-coop: two players share one world", () => {
  it("admin creates world coop-1 and provisions two players", async () => {
    const worldRes = await api("POST", "/api/worlds", { worldId: "coop-1", name: "Co-op Test" }, ADMIN_TOKEN);
    expect(worldRes.status).toBe(201);
    expect(worldRes.body.worldId).toBe("coop-1");

    const tok1 = await provisionPlayer("coop-1");
    const tok2 = await provisionPlayer("coop-1");
    expect(tok1).toMatch(/^strata_v2\./);
    expect(tok2).toMatch(/^strata_v2\./);
    // Different players get different tokens
    expect(tok1).not.toBe(tok2);
  });

  it("PC1 stores memory on Goran — PC2 recall returns it (shared NPC memory)", async () => {
    await api("POST", "/api/worlds", { worldId: "coop-1" }, ADMIN_TOKEN);
    const tok1 = await provisionPlayer("coop-1");
    const tok2 = await provisionPlayer("coop-1");

    // PC1 stores a memory on Goran
    const storeRes = await api(
      "POST", "/api/agents/goran/store",
      { memory: "Goran told us about the hidden forge entrance.", type: "fact" },
      tok1
    );
    expect(storeRes.status).toBe(200);
    expect(storeRes.body.stored).toBe(true);

    // PC2 recalls from Goran — should see PC1's memory (world-scoped)
    const recallRes = await api(
      "POST", "/api/agents/goran/recall",
      { situation: "forge entrance hidden" },
      tok2
    );
    expect(recallRes.status).toBe(200);
    const context = recallRes.body.context as Array<{ text: string }>;
    expect(Array.isArray(context)).toBe(true);
    expect(context.length).toBeGreaterThan(0);
    const hit = context.find((c) => c.text.includes("forge entrance"));
    expect(hit).toBeDefined();
  });

  it("PC1 searches Goran — also finds PC1's memory (world-scoped search)", async () => {
    await api("POST", "/api/worlds", { worldId: "coop-1" }, ADMIN_TOKEN);
    const tok1 = await provisionPlayer("coop-1");
    const tok2 = await provisionPlayer("coop-1");

    await api(
      "POST", "/api/agents/goran/store",
      { memory: "The blacksmith has a secret stash of mithril." },
      tok1
    );

    // PC2 searches
    const searchRes = await api(
      "POST", "/api/agents/goran/search",
      { query: "mithril stash" },
      tok2
    );
    expect(searchRes.status).toBe(200);
    const results = searchRes.body.results as Array<{ text: string }>;
    expect(results.length).toBeGreaterThan(0);
    const hit = results.find((r) => r.text.includes("mithril"));
    expect(hit).toBeDefined();
  });

  it("PC1 relationship update does NOT affect PC2's relationship (per-player)", async () => {
    await api("POST", "/api/worlds", { worldId: "coop-1" }, ADMIN_TOKEN);

    // Set up Goran's profile with tag rules so that observe has an effect (X-Strata-World routes to coop-1)
    await fetch(`${baseUrl}/api/agents/goran/profile`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ADMIN_TOKEN}`,
        "X-Strata-World": "coop-1",
      },
      body: JSON.stringify({
        name: "Goran",
        alignment: { ethical: "lawful", moral: "good" },
        defaultTrust: 50,
      }),
    });

    const tok1 = await provisionPlayer("coop-1");
    const tok2 = await provisionPlayer("coop-1");

    // PC1 observes a helpful event (trust +)
    const observeRes = await api(
      "POST", "/api/agents/goran/relationship/observe",
      { event: "helped-with-quest", tags: ["helpful", "quest"] },
      tok1
    );
    expect(observeRes.status).toBe(200);

    // PC1's relationship shows updated observations
    const rel1 = await api("GET", "/api/agents/goran/relationship", {}, tok1);
    expect(rel1.status).toBe(200);
    const obs1 = (rel1.body as Record<string, unknown>).observations as unknown[];
    expect(Array.isArray(obs1)).toBe(true);
    expect(obs1.length).toBeGreaterThan(0);

    // PC2's relationship is independent — no observations
    const rel2 = await api("GET", "/api/agents/goran/relationship", {}, tok2);
    expect(rel2.status).toBe(200);
    const obs2 = (rel2.body as Record<string, unknown>).observations as unknown[];
    expect(Array.isArray(obs2)).toBe(true);
    expect(obs2.length).toBe(0);
  });

  it("gossip interaction — both PC1 and PC2 see the gossiped memory on Brynn", async () => {
    await api("POST", "/api/worlds", { worldId: "coop-1" }, ADMIN_TOKEN);
    const tok1 = await provisionPlayer("coop-1");
    const tok2 = await provisionPlayer("coop-1");

    // Profile Goran as gossipy with confession propagation tag (X-Strata-World routes to coop-1)
    await fetch(`${baseUrl}/api/agents/goran/profile`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ADMIN_TOKEN}`,
        "X-Strata-World": "coop-1",
      },
      body: JSON.stringify({
        name: "Goran",
        alignment: { ethical: "lawful", moral: "good" },
        gossipTrait: "gossipy",
        propagateTags: ["confession"],
      }),
    });
    await fetch(`${baseUrl}/api/agents/brynn/profile`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ADMIN_TOKEN}`,
        "X-Strata-World": "coop-1",
      },
      body: JSON.stringify({ name: "Brynn", alignment: { ethical: "neutral", moral: "good" } }),
    });

    // PC1 stores the confession memory on Goran (world-scoped)
    await api(
      "POST", "/api/agents/goran/store",
      {
        memory: "The innkeeper confessed to poisoning the merchant's wine.",
        tags: ["confession", "juicy"],
      },
      tok1
    );

    // Fire interactions until we get a disclosure (deterministic seed iteration)
    let disclosed = false;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const r = await api(
        "POST", "/api/interactions",
        { npcA: "goran", npcB: "brynn", seed },
        tok1
      );
      expect(r.status).toBe(200);
      const ds = r.body.disclosures as Array<{ result: string }>;
      if (Array.isArray(ds) && ds.some((d) => d.result === "disclosed")) {
        disclosed = true;
        break;
      }
    }
    expect(disclosed).toBe(true);

    // PC1 sees the gossip on Brynn (search by distinctive word from the stored content)
    const recall1 = await api(
      "POST", "/api/agents/brynn/recall",
      { situation: "innkeeper confessed merchant" },
      tok1
    );
    expect(recall1.status).toBe(200);
    const ctx1 = recall1.body.context as Array<{ text: string }>;
    expect(ctx1.length).toBeGreaterThan(0);
    expect(ctx1.some((c) => c.text.includes("innkeeper"))).toBe(true);

    // PC2 also sees the same gossip on Brynn (world-scoped memory)
    const recall2 = await api(
      "POST", "/api/agents/brynn/recall",
      { situation: "innkeeper confessed merchant" },
      tok2
    );
    expect(recall2.status).toBe(200);
    const ctx2 = recall2.body.context as Array<{ text: string }>;
    expect(ctx2.length).toBeGreaterThan(0);
    expect(ctx2.some((c) => c.text.includes("innkeeper"))).toBe(true);
  });
});
