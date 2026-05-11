import { describe, it, expect, afterEach } from "vitest";
import { startRestTransport, type RestTransportHandle } from "../../src/transports/rest-transport.js";
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import { join } from "path";

let handle: RestTransportHandle | undefined;
const VALID_ADMIN_TOKEN = "a".repeat(32);

/** Create a unique temp dir for each test to avoid cross-test contamination */
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "strata-rest-test-"));
}

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = undefined;
  }
});

function getBaseUrl(): string {
  const addr = handle!.server.address();
  if (typeof addr === "object" && addr !== null) {
    return `http://127.0.0.1:${addr.port}`;
  }
  throw new Error("No address");
}

describe("REST Transport — token secret enforcement", () => {
  it("refuses to start when STRATA_TOKEN_SECRET is unset and no dev opt-in", async () => {
    const prevSecret = process.env.STRATA_TOKEN_SECRET;
    const prevOptIn = process.env.STRATA_ALLOW_INSECURE_DEV_SECRET;
    delete process.env.STRATA_TOKEN_SECRET;
    delete process.env.STRATA_ALLOW_INSECURE_DEV_SECRET;
    try {
      await expect(
        startRestTransport({ port: 0, baseDir: makeTempDir() })
      ).rejects.toThrow(/STRATA_TOKEN_SECRET is not set/);
    } finally {
      if (prevSecret !== undefined) process.env.STRATA_TOKEN_SECRET = prevSecret;
      if (prevOptIn !== undefined) process.env.STRATA_ALLOW_INSECURE_DEV_SECRET = prevOptIn;
    }
  });

  it("starts with the insecure fallback when STRATA_ALLOW_INSECURE_DEV_SECRET=1", async () => {
    const prevSecret = process.env.STRATA_TOKEN_SECRET;
    const prevOptIn = process.env.STRATA_ALLOW_INSECURE_DEV_SECRET;
    delete process.env.STRATA_TOKEN_SECRET;
    process.env.STRATA_ALLOW_INSECURE_DEV_SECRET = "1";
    try {
      handle = await startRestTransport({ port: 0, baseDir: makeTempDir() });
      const res = await fetch(`${getBaseUrl()}/api/health`);
      expect(res.status).toBe(200);
    } finally {
      if (prevSecret !== undefined) process.env.STRATA_TOKEN_SECRET = prevSecret;
      else delete process.env.STRATA_TOKEN_SECRET;
      if (prevOptIn !== undefined) process.env.STRATA_ALLOW_INSECURE_DEV_SECRET = prevOptIn;
      else delete process.env.STRATA_ALLOW_INSECURE_DEV_SECRET;
    }
  });
});

describe("REST Transport — body size cap", () => {
  it("rejects POST bodies larger than 1MB with 413", async () => {
    handle = await startRestTransport({ port: 0, baseDir: makeTempDir() });
    // Build a >1MB JSON payload (a single string field padded with 'a's)
    const padding = "a".repeat(1_100_000);
    const body = JSON.stringify({ memory: padding, tags: [] });
    const res = await fetch(`${getBaseUrl()}/api/agents/npc1/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(413);
    const payload = await res.json();
    expect(payload.error).toMatch(/exceeds/);
  });
});

describe("REST Transport — health and auth", () => {
  it("GET /api/health returns 200 with status ok", async () => {
    handle = await startRestTransport({ port: 0, baseDir: makeTempDir() });
    const res = await fetch(`${getBaseUrl()}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.version).toBeDefined();
  });

  it("rejects requests without token when token is configured", async () => {
    handle = await startRestTransport({ port: 0, token: VALID_ADMIN_TOKEN, baseDir: makeTempDir() });
    const res = await fetch(`${getBaseUrl()}/api/agents/npc1/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "test" }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts requests with valid bearer token", async () => {
    handle = await startRestTransport({ port: 0, token: VALID_ADMIN_TOKEN, baseDir: makeTempDir() });
    const res = await fetch(`${getBaseUrl()}/api/agents/npc1/store`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${VALID_ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ memory: "test memory for token check", type: "fact" }),
    });
    // Should succeed (200) or at least not 401
    expect(res.status).not.toBe(401);
  });

  it("allows requests without token when no token configured (local dev)", async () => {
    handle = await startRestTransport({ port: 0, baseDir: makeTempDir() });
    const res = await fetch(`${getBaseUrl()}/api/agents/npc1/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memory: "test memory no auth needed", type: "fact" }),
    });
    expect(res.status).not.toBe(401);
  });

  it("returns 404 for unknown routes", async () => {
    handle = await startRestTransport({ port: 0, baseDir: makeTempDir() });
    const res = await fetch(`${getBaseUrl()}/api/nonexistent`);
    expect(res.status).toBe(404);
  });
});

describe("REST Transport — store + search + delete", () => {
  it("stores a memory and retrieves it via search", async () => {
    handle = await startRestTransport({ port: 0, baseDir: makeTempDir() });
    const base = getBaseUrl();

    // Store
    const storeRes = await fetch(`${base}/api/agents/npc-blacksmith/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        memory: "The player saved my daughter from wolves on day 3",
        type: "episodic",
        tags: ["player-relationship", "quest-wolves"],
      }),
    });
    expect(storeRes.status).toBe(200);
    const stored = await storeRes.json();
    expect(stored.stored).toBe(true);
    expect(stored.id).toBeDefined();

    // Search
    const searchRes = await fetch(`${base}/api/agents/npc-blacksmith/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "wolves daughter", limit: 5 }),
    });
    expect(searchRes.status).toBe(200);
    const searched = await searchRes.json();
    expect(searched.results.length).toBeGreaterThanOrEqual(1);
    expect(searched.results[0].text).toContain("wolves");

    // Delete
    const deleteRes = await fetch(
      `${base}/api/agents/npc-blacksmith/memory/${stored.id}`,
      { method: "DELETE" }
    );
    expect(deleteRes.status).toBe(200);
    const deleted = await deleteRes.json();
    expect(deleted.deleted).toBe(true);
  });

  it("recall returns context and summary", async () => {
    handle = await startRestTransport({ port: 0, baseDir: makeTempDir() });
    const base = getBaseUrl();

    // Store some memories
    await fetch(`${base}/api/agents/npc-merchant/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memory: "Player prefers lightweight weapons", type: "preference" }),
    });
    await fetch(`${base}/api/agents/npc-merchant/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memory: "Player completed the wolf quest on day 3", type: "episodic" }),
    });

    // Recall
    const recallRes = await fetch(`${base}/api/agents/npc-merchant/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ situation: "player is asking about buying a sword", limit: 5 }),
    });
    expect(recallRes.status).toBe(200);
    const recalled = await recallRes.json();
    expect(recalled.context).toBeDefined();
    expect(recalled.summary).toBeDefined();
    expect(typeof recalled.summary).toBe("string");
  });

  it("isolates memories between agents", async () => {
    handle = await startRestTransport({ port: 0, baseDir: makeTempDir() });
    const base = getBaseUrl();

    // Store in npc-a
    await fetch(`${base}/api/agents/npc-a/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memory: "Secret only npc-a knows about treasure", type: "fact" }),
    });

    // Search in npc-b should find nothing
    const searchRes = await fetch(`${base}/api/agents/npc-b/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "treasure secret", limit: 5 }),
    });
    const searched = await searchRes.json();
    expect(searched.results.length).toBe(0);
  });

  it("returns 400 for missing required fields", async () => {
    handle = await startRestTransport({ port: 0, baseDir: makeTempDir() });
    const base = getBaseUrl();

    const res = await fetch(`${base}/api/agents/npc1/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}), // missing memory field
    });
    expect(res.status).toBe(400);
  });

  it("DELETE /api/agents/:agentId/memories deletes all memories for that agent", async () => {
    handle = await startRestTransport({ port: 0, baseDir: makeTempDir() });
    const base = getBaseUrl();

    // Arrange: 3 memories on goran, 2 on brynn
    for (const memory of ["A memory one", "A memory two", "A memory three"]) {
      await fetch(`${base}/api/agents/goran/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memory, importance: 50 }),
      });
    }
    for (const memory of ["X memory one", "Y memory two"]) {
      await fetch(`${base}/api/agents/brynn/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memory, importance: 50 }),
      });
    }

    // Act: bulk-delete goran's memories
    const res = await fetch(`${base}/api/agents/goran/memories`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(3);
    expect(body.agentId).toBe("goran");

    // Assert: goran empty, brynn untouched
    const goranSearch = await fetch(`${base}/api/agents/goran/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "memory", limit: 10 }),
    });
    const goranSearched = await goranSearch.json();
    expect(goranSearched.results.length).toBe(0);

    const brynnSearch = await fetch(`${base}/api/agents/brynn/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "memory", limit: 10 }),
    });
    const brynnSearched = await brynnSearch.json();
    expect(brynnSearched.results.length).toBe(2);
  });

  it("DELETE /api/agents/:agentId/memories returns deleted=0 when no memories exist", async () => {
    handle = await startRestTransport({ port: 0, baseDir: makeTempDir() });
    const base = getBaseUrl();

    const res = await fetch(`${base}/api/agents/empty-npc/memories`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(0);
    expect(body.agentId).toBe("empty-npc");
  });
});

describe("REST Transport — training endpoint", () => {
  it("captures a dialogue training pair", async () => {
    handle = await startRestTransport({ port: 0, baseDir: makeTempDir() });
    const base = getBaseUrl();

    const res = await fetch(`${base}/api/agents/npc-blacksmith/training`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: "Player: Can I get a discount?\n\n[Memories: player saved daughter]",
        output: "Take it — no charge. A father's gratitude.",
        model: "claude-sonnet-4-6",
        quality: 0.95,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stored).toBe(true);
    expect(body.task_type).toBe("dialogue");
  });
});

describe("REST Transport — admin endpoints (player provisioning)", () => {
  const ADMIN_TOKEN = "a".repeat(32);

  it("POST /api/players with admin token returns a new player token", async () => {
    handle = await startRestTransport({
      port: 0,
      token: ADMIN_TOKEN,
      baseDir: makeTempDir(),
    });
    const res = await fetch(`${getBaseUrl()}/api/players`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ externalId: "device:abc:slot1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.playerId).toBeDefined();
    expect(body.playerToken).toMatch(/^pt_[0-9a-f]{32}$/);
    expect(body.isNew).toBe(true);
  });

  it("POST /api/players rejects a player token (wrong tier)", async () => {
    handle = await startRestTransport({
      port: 0,
      token: ADMIN_TOKEN,
      baseDir: makeTempDir(),
    });
    // Provision a player first
    const provisionRes = await fetch(`${getBaseUrl()}/api/players`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({}),
    });
    const { playerToken } = await provisionRes.json();

    // Try to use the player token on an admin endpoint
    const res = await fetch(`${getBaseUrl()}/api/players`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${playerToken}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it("POST /api/players is idempotent on externalId", async () => {
    handle = await startRestTransport({
      port: 0,
      token: ADMIN_TOKEN,
      baseDir: makeTempDir(),
    });
    const body = JSON.stringify({ externalId: "device:same:slot1" });
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    };
    const first = await (
      await fetch(`${getBaseUrl()}/api/players`, { method: "POST", headers, body })
    ).json();
    const second = await (
      await fetch(`${getBaseUrl()}/api/players`, { method: "POST", headers, body })
    ).json();
    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(second.playerId).toBe(first.playerId);
  });

  it("data endpoint rejects admin token with 403", async () => {
    handle = await startRestTransport({
      port: 0,
      token: ADMIN_TOKEN,
      baseDir: makeTempDir(),
    });
    const res = await fetch(`${getBaseUrl()}/api/agents/goran/store`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ memory: "admin trying to store", type: "fact" }),
    });
    expect(res.status).toBe(403);
  });

  it("data endpoint accepts a player token and stores to per-player path", async () => {
    const baseDir = makeTempDir();
    handle = await startRestTransport({ port: 0, token: ADMIN_TOKEN, baseDir });
    const { playerId, playerToken } = await (
      await fetch(`${getBaseUrl()}/api/players`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        body: JSON.stringify({ externalId: "device:path-test:slot1" }),
      })
    ).json();

    const storeRes = await fetch(`${getBaseUrl()}/api/agents/goran/store`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${playerToken}`,
      },
      body: JSON.stringify({ memory: "player-scoped memory entry", type: "fact" }),
    });
    expect(storeRes.status).toBe(200);

    // Verify the database landed at the per-player path
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dbPath = join(baseDir, "players", playerId, "agents", "goran", "strata.db");
    expect(existsSync(dbPath)).toBe(true);
  });

  it("GET /api/players/:playerId returns player metadata", async () => {
    handle = await startRestTransport({
      port: 0,
      token: ADMIN_TOKEN,
      baseDir: makeTempDir(),
    });
    const { playerId } = await (
      await fetch(`${getBaseUrl()}/api/players`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        body: JSON.stringify({ externalId: "device:info" }),
      })
    ).json();

    const res = await fetch(`${getBaseUrl()}/api/players/${playerId}`, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.playerId).toBe(playerId);
    expect(body.externalId).toBe("device:info");
    expect(body.createdAt).toBeGreaterThan(0);
  });

  it("DELETE /api/players/:playerId removes the player and invalidates the token", async () => {
    handle = await startRestTransport({
      port: 0,
      token: ADMIN_TOKEN,
      baseDir: makeTempDir(),
    });
    const { playerId, playerToken } = await (
      await fetch(`${getBaseUrl()}/api/players`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        body: JSON.stringify({}),
      })
    ).json();

    const delRes = await fetch(`${getBaseUrl()}/api/players/${playerId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(delRes.status).toBe(200);

    // The player token should no longer work
    const dataRes = await fetch(`${getBaseUrl()}/api/agents/goran/store`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${playerToken}`,
      },
      body: JSON.stringify({ memory: "should fail post-delete", type: "fact" }),
    });
    expect(dataRes.status).toBe(401);
  });

  it("rejects admin token shorter than 32 characters at startup", async () => {
    await expect(
      startRestTransport({ port: 0, token: "short", baseDir: makeTempDir() })
    ).rejects.toThrow(/at least 32 characters/);
  });

  it("no-auth mode routes data to the default player", async () => {
    const baseDir = makeTempDir();
    handle = await startRestTransport({ port: 0, baseDir });
    const res = await fetch(`${getBaseUrl()}/api/agents/goran/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memory: "default player memory", type: "fact" }),
    });
    expect(res.status).toBe(200);

    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dbPath = join(baseDir, "players", "default", "agents", "goran", "strata.db");
    expect(existsSync(dbPath)).toBe(true);
  });
});

describe("REST Transport — LRU eviction", () => {
  const ADMIN_TOKEN = "a".repeat(32);

  it("evicts least-recently-used (player, npc) entries when cache exceeds maxAgents", async () => {
    handle = await startRestTransport({
      port: 0,
      token: ADMIN_TOKEN,
      baseDir: makeTempDir(),
      maxAgents: 2,
    });

    const { playerToken } = await (
      await fetch(`${getBaseUrl()}/api/players`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        body: JSON.stringify({ externalId: "device:lru" }),
      })
    ).json();

    const storeTo = (npcId: string) =>
      fetch(`${getBaseUrl()}/api/agents/${npcId}/store`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${playerToken}`,
        },
        body: JSON.stringify({ memory: `memory for ${npcId}`, type: "fact" }),
      });

    // 3 distinct NPCs into a cache of size 2 — the first should be evicted
    await storeTo("goran");
    await storeTo("brynn");
    await storeTo("mira");

    const healthRes = await fetch(`${getBaseUrl()}/api/health`);
    const health = await healthRes.json();
    expect(health.agents).toBe(2);
  });
});

describe("REST Transport — hybrid retrieval and fallback", () => {
  it("returns source:'fts5' when no embedder is configured", async () => {
    const originalKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      handle = await startRestTransport({ port: 0, baseDir: makeTempDir() });

      await fetch(`${getBaseUrl()}/api/agents/goran/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memory: "The player's name is Alex the Bold",
          type: "fact",
        }),
      });

      const recallRes = await fetch(`${getBaseUrl()}/api/agents/goran/recall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ situation: "What is the player's name?" }),
      });
      expect(recallRes.status).toBe(200);
      const body = await recallRes.json();
      expect(body.context).toBeDefined();
      expect(Array.isArray(body.context)).toBe(true);
      if (body.context.length > 0) {
        expect(body.context[0].source).toBe("fts5");
      }
    } finally {
      if (originalKey !== undefined) process.env.GEMINI_API_KEY = originalKey;
    }
  });

  it("/search includes source field in results", async () => {
    handle = await startRestTransport({ port: 0, baseDir: makeTempDir() });
    await fetch(`${getBaseUrl()}/api/agents/goran/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memory: "The forge is hot today", type: "fact" }),
    });
    const res = await fetch(`${getBaseUrl()}/api/agents/goran/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "forge" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toBeDefined();
    if (body.results.length > 0) {
      expect(body.results[0].source).toMatch(/^(hybrid|fts5)$/);
    }
  });
});

describe("REST Transport — hybrid retrieval with real embedder", () => {
  const hasGemini = typeof process.env.GEMINI_API_KEY === "string" && process.env.GEMINI_API_KEY.length > 0;
  const maybeIt = hasGemini ? it : it.skip;

  maybeIt("returns source:'hybrid' when Gemini embeddings are available", async () => {
    handle = await startRestTransport({ port: 0, baseDir: makeTempDir() });

    await fetch(`${getBaseUrl()}/api/agents/goran/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        memory: "The quickest path to Ravenhollow winds through the eastern pass",
        type: "fact",
      }),
    });

    // Wait briefly for the fire-and-forget embedder to index the entry
    await new Promise((r) => setTimeout(r, 2000));

    const res = await fetch(`${getBaseUrl()}/api/agents/goran/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        situation: "Which direction should we travel to reach the hidden village?",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.context.length).toBeGreaterThan(0);
    expect(body.context[0].source).toBe("hybrid");
  }, 15000);
});

describe("REST Transport — NPC profiles", () => {
  const ADMIN_TOKEN = "a".repeat(32);

  it("PUT /api/agents/:npcId/profile creates a profile (admin)", async () => {
    handle = await startRestTransport({ port: 0, token: ADMIN_TOKEN, baseDir: makeTempDir() });
    const res = await fetch(`${getBaseUrl()}/api/agents/goran/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({
        name: "Goran", title: "Blacksmith",
        alignment: { ethical: "lawful", moral: "good" },
        traits: ["honest"], backstory: "Runs the forge.",
        defaultTrust: -0.1,
        factionBias: { "merchants": 0.3 },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(true);
    expect(body.profile.name).toBe("Goran");
  });

  it("PUT profile rejects player token with 403", async () => {
    handle = await startRestTransport({ port: 0, token: ADMIN_TOKEN, baseDir: makeTempDir() });
    const { playerToken } = await (await fetch(`${getBaseUrl()}/api/players`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({}),
    })).json();
    const res = await fetch(`${getBaseUrl()}/api/agents/goran/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${playerToken}` },
      body: JSON.stringify({ name: "Goran", alignment: { ethical: "lawful", moral: "good" } }),
    });
    expect(res.status).toBe(403);
  });

  it("GET profile returns merged profile + metadata", async () => {
    const baseDir = makeTempDir();
    handle = await startRestTransport({ port: 0, token: ADMIN_TOKEN, baseDir });
    // Create profile
    await fetch(`${getBaseUrl()}/api/agents/goran/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({
        name: "Goran", alignment: { ethical: "lawful", moral: "good" },
        defaultTrust: -0.1,
      }),
    });
    // Provision player and store a memory
    const { playerToken } = await (await fetch(`${getBaseUrl()}/api/players`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({}),
    })).json();
    await fetch(`${getBaseUrl()}/api/agents/goran/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${playerToken}` },
      body: JSON.stringify({ memory: "test memory for profile check", type: "fact" }),
    });
    // Read profile with player token
    const res = await fetch(`${getBaseUrl()}/api/agents/goran/profile`, {
      headers: { Authorization: `Bearer ${playerToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Goran");
    expect(body.agent_id).toBe("goran");
    expect(body.memory_count).toBeGreaterThanOrEqual(1);
    expect(body.defaultTrust).toBe(-0.1);
  });

  it("PUT profile returns 422 on invalid alignment", async () => {
    handle = await startRestTransport({ port: 0, token: ADMIN_TOKEN, baseDir: makeTempDir() });
    const res = await fetch(`${getBaseUrl()}/api/agents/goran/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ name: "Goran", alignment: { ethical: "chaotic-good", moral: "good" } }),
    });
    expect(res.status).toBe(422);
  });
});

describe("REST Transport — character cards", () => {
  const ADMIN_TOKEN = "a".repeat(32);

  it("PUT + GET character card round-trips", async () => {
    handle = await startRestTransport({ port: 0, token: ADMIN_TOKEN, baseDir: makeTempDir() });
    const { playerId, playerToken } = await (await fetch(`${getBaseUrl()}/api/players`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({}),
    })).json();

    await fetch(`${getBaseUrl()}/api/players/${playerId}/character`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${playerToken}` },
      body: JSON.stringify({ displayName: "Mike", factions: ["merchants"], tags: ["human"] }),
    });

    const res = await fetch(`${getBaseUrl()}/api/players/${playerId}/character`, {
      headers: { Authorization: `Bearer ${playerToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.displayName).toBe("Mike");
    expect(body.factions).toEqual(["merchants"]);
  });

  it("player cannot read another player's character card", async () => {
    handle = await startRestTransport({ port: 0, token: ADMIN_TOKEN, baseDir: makeTempDir() });
    const { playerToken } = await (await fetch(`${getBaseUrl()}/api/players`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({}),
    })).json();

    const res = await fetch(`${getBaseUrl()}/api/players/some-other-player/character`, {
      headers: { Authorization: `Bearer ${playerToken}` },
    });
    expect(res.status).toBe(403);
  });
});

describe("REST Transport — relationships and first-contact", () => {
  const ADMIN_TOKEN = "a".repeat(32);

  async function setupPlayerWithProfile(baseUrl: string) {
    // Create NPC profile
    await fetch(`${baseUrl}/api/agents/goran/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({
        name: "Goran", alignment: { ethical: "lawful", moral: "good" },
        defaultTrust: -0.1, factionBias: { merchants: 0.3 },
      }),
    });
    // Provision player
    const { playerId, playerToken } = await (await fetch(`${baseUrl}/api/players`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({}),
    })).json();
    // Set character card with merchant faction
    await fetch(`${baseUrl}/api/players/${playerId}/character`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${playerToken}` },
      body: JSON.stringify({ displayName: "Mike", factions: ["merchants"], tags: ["human"] }),
    });
    return { playerId, playerToken };
  }

  it("GET relationship returns first-contact computed trust", async () => {
    handle = await startRestTransport({ port: 0, token: ADMIN_TOKEN, baseDir: makeTempDir() });
    const { playerToken } = await setupPlayerWithProfile(getBaseUrl());

    const res = await fetch(`${getBaseUrl()}/api/agents/goran/relationship`, {
      headers: { Authorization: `Bearer ${playerToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.trust).toBeCloseTo(0.2); // -0.1 + 0.3
    expect(body.familiarity).toBe(0);
    expect(body.disposition).toBe("wary");
    expect(body.observations).toEqual([]);
  });

  it("POST /observe shifts trust and records observation", async () => {
    handle = await startRestTransport({ port: 0, token: ADMIN_TOKEN, baseDir: makeTempDir() });
    const { playerToken } = await setupPlayerWithProfile(getBaseUrl());

    const res = await fetch(`${getBaseUrl()}/api/agents/goran/relationship/observe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${playerToken}` },
      body: JSON.stringify({ event: "helped-at-forge", tags: ["cooperation"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.trust).toBeGreaterThan(0.2); // first-contact 0.2 + cooperation delta
    expect(body.disposition).toBeDefined();

    // Verify observation persisted
    const relRes = await fetch(`${getBaseUrl()}/api/agents/goran/relationship`, {
      headers: { Authorization: `Bearer ${playerToken}` },
    });
    const rel = await relRes.json();
    expect(rel.observations.length).toBe(1);
    expect(rel.observations[0].event).toBe("helped-at-forge");
    expect(rel.familiarity).toBe(1);
  });
});

describe("REST Transport — decay and anchor endpoints", () => {
  it("GET /relationship returns anchor field (null for new relationships)", async () => {
    handle = await startRestTransport({ port: 0, baseDir: makeTempDir() });
    const base = getBaseUrl();
    const res = await fetch(`${base}/api/agents/npc1/relationship`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.anchor).toBeNull();
    expect(body.trust).toBeDefined();
  });

  it("PUT /agents/:npcId/anchor sets anchor state (no-auth mode)", async () => {
    handle = await startRestTransport({ port: 0, baseDir: makeTempDir() });
    const base = getBaseUrl();

    // Create a relationship first
    await fetch(`${base}/api/agents/brother/relationship/observe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "meeting", tags: ["cooperation"] }),
    });

    // Set anchor
    const res = await fetch(`${base}/api/agents/brother/anchor`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "friend", depth: 0.8 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.anchor.state).toBe("friend");
    expect(body.anchor.depth).toBe(0.8);

    // Verify via GET
    const getRes = await fetch(`${base}/api/agents/brother/relationship`);
    const getRel = await getRes.json();
    expect(getRel.anchor.state).toBe("friend");
  });

  it("PUT /agents/:npcId/anchor with state=none removes anchor", async () => {
    handle = await startRestTransport({ port: 0, baseDir: makeTempDir() });
    const base = getBaseUrl();

    await fetch(`${base}/api/agents/npc2/relationship/observe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "meeting", tags: [] }),
    });

    await fetch(`${base}/api/agents/npc2/anchor`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "friend", depth: 0.5 }),
    });

    const res = await fetch(`${base}/api/agents/npc2/anchor`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "none", depth: 0 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.anchor).toBeNull();
  });

  it("store with anchor-eligible tag triggers anchor processing", async () => {
    handle = await startRestTransport({ port: 0, baseDir: makeTempDir() });
    const base = getBaseUrl();

    // Set up NPC profile with low familiarity threshold
    await fetch(`${base}/api/agents/hero-npc/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Hero",
        alignment: { ethical: "lawful", moral: "good" },
        anchorConfig: { familiarityThreshold: 2, rivalThreshold: 0.3, depthIncrement: 0.15, passiveDepthCeiling: 0.3, passiveDepthRate: 0.01 },
      }),
    });

    // Build familiarity
    for (let i = 0; i < 3; i++) {
      await fetch(`${base}/api/agents/hero-npc/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memory: `interaction ${i} with the hero NPC`, type: "episodic", tags: ["cooperation"] }),
      });
    }

    // Store with anchor-eligible tag
    await fetch(`${base}/api/agents/hero-npc/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memory: "player saved the NPC from danger in the forest", type: "episodic", tags: ["saved-my-life"] }),
    });

    // Check relationship
    const relRes = await fetch(`${base}/api/agents/hero-npc/relationship`);
    const rel = await relRes.json();
    expect(rel.anchor).not.toBeNull();
    expect(rel.anchor.state).toBe("friend");
  });

  it("recall applies memory decay (fading profile returns results)", async () => {
    const dir = makeTempDir();
    handle = await startRestTransport({ port: 0, baseDir: dir });
    const base = getBaseUrl();

    // Set NPC to fading profile
    await fetch(`${base}/api/agents/fading-npc/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Forgetful",
        alignment: { ethical: "neutral", moral: "neutral" },
        decayProfile: "fading",
      }),
    });

    // Store a memory
    await fetch(`${base}/api/agents/fading-npc/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memory: "The player mentioned liking swords a lot", type: "preference" }),
    });

    // Recall immediately — should have results
    const recallRes = await fetch(`${base}/api/agents/fading-npc/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ situation: "player asks about swords", limit: 5 }),
    });
    expect(recallRes.status).toBe(200);
    const recalled = await recallRes.json();
    // Memory was just stored, so decay multiplier is ~1.0
    expect(recalled.context.length).toBeGreaterThanOrEqual(1);
  });
});

describe("REST Transport — tag-rule auto-fire on /store", () => {
  const ADMIN_TOKEN = "a".repeat(32);

  it("storing a memory with tags automatically shifts trust", async () => {
    handle = await startRestTransport({ port: 0, token: ADMIN_TOKEN, baseDir: makeTempDir() });

    // Create NPC profile (lawful good)
    await fetch(`${getBaseUrl()}/api/agents/goran/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({
        name: "Goran",
        alignment: { ethical: "lawful", moral: "good" },
        defaultTrust: 0.0,
        factionBias: {},
      }),
    });

    // Provision player
    const { playerToken } = await (await fetch(`${getBaseUrl()}/api/players`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({}),
    })).json();

    // Store a memory with theft tag
    await fetch(`${getBaseUrl()}/api/agents/goran/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${playerToken}` },
      body: JSON.stringify({
        memory: "Player stole bread from the market",
        type: "episodic",
        tags: ["theft", "crime"],
      }),
    });

    // Check that relationship was updated
    const relRes = await fetch(`${getBaseUrl()}/api/agents/goran/relationship`, {
      headers: { Authorization: `Bearer ${playerToken}` },
    });
    const rel = await relRes.json();
    expect(rel.trust).toBeLessThan(0); // theft tag should produce negative delta
    expect(rel.observations.length).toBe(1);
    expect(rel.observations[0].source).toBe("tag-rule");
    expect(rel.observations[0].tags).toContain("theft");
  });

  it("storing a memory without tags does not create a relationship observation", async () => {
    handle = await startRestTransport({ port: 0, token: ADMIN_TOKEN, baseDir: makeTempDir() });

    const { playerToken } = await (await fetch(`${getBaseUrl()}/api/players`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({}),
    })).json();

    // Store memory with no tags
    await fetch(`${getBaseUrl()}/api/agents/goran/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${playerToken}` },
      body: JSON.stringify({ memory: "Player said hello", type: "episodic" }),
    });

    // Relationship should be first-contact state (no observations)
    const relRes = await fetch(`${getBaseUrl()}/api/agents/goran/relationship`, {
      headers: { Authorization: `Bearer ${playerToken}` },
    });
    const rel = await relRes.json();
    expect(rel.observations.length).toBe(0);
  });

  it("dialogue-tagged store increments familiarity even when trust delta is zero", async () => {
    // Regression: stores with tags that produce delta.trust=0 (e.g. "dialogue")
    // must still record an observation so familiarity accumulates across turns.
    handle = await startRestTransport({ port: 0, token: ADMIN_TOKEN, baseDir: makeTempDir() });

    // No NPC profile configured — dialogue-only NPC has no tag rules
    // so computeTrustDelta returns {trust:0} and computeAnchorOutcome returns no-op.

    const { playerToken } = await (await fetch(`${getBaseUrl()}/api/players`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({}),
    })).json();

    // Store a memory with "dialogue" tag — no trust delta expected
    const storeRes = await fetch(`${getBaseUrl()}/api/agents/test-npc/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${playerToken}` },
      body: JSON.stringify({ memory: "Player greeted the NPC warmly", type: "fact", tags: ["dialogue"] }),
    });
    expect(storeRes.status).toBe(200);

    // Familiarity must be 1 and observation must be recorded
    const relRes = await fetch(`${getBaseUrl()}/api/agents/test-npc/relationship`, {
      headers: { Authorization: `Bearer ${playerToken}` },
    });
    const rel = await relRes.json();
    expect(rel.familiarity).toBe(1);
    expect(rel.observations.length).toBe(1);
    expect(rel.observations[0].tags).toContain("dialogue");
  });
});

describe("REST Transport — world lifecycle endpoints", () => {
  const ADMIN_TOKEN = "a".repeat(32);

  it("GET /api/worlds returns at least the default world on boot", async () => {
    handle = await startRestTransport({ port: 0, token: ADMIN_TOKEN, baseDir: makeTempDir() });
    const res = await fetch(`${getBaseUrl()}/api/worlds`, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.worlds)).toBe(true);
    expect(body.worlds.some((w: { worldId: string }) => w.worldId === "default")).toBe(true);
  });

  it("POST /api/worlds creates a new world (201)", async () => {
    handle = await startRestTransport({ port: 0, token: ADMIN_TOKEN, baseDir: makeTempDir() });
    const res = await fetch(`${getBaseUrl()}/api/worlds`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ worldId: "story-1", name: "Story One" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.worldId).toBe("story-1");
    expect(body.name).toBe("Story One");
  });

  it("POST /api/worlds returns 409 on duplicate worldId", async () => {
    handle = await startRestTransport({ port: 0, token: ADMIN_TOKEN, baseDir: makeTempDir() });
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` };
    await fetch(`${getBaseUrl()}/api/worlds`, {
      method: "POST",
      headers,
      body: JSON.stringify({ worldId: "dupe", name: "First" }),
    });
    const res = await fetch(`${getBaseUrl()}/api/worlds`, {
      method: "POST",
      headers,
      body: JSON.stringify({ worldId: "dupe", name: "Second" }),
    });
    expect(res.status).toBe(409);
  });

  it("POST /api/worlds returns 400 on invalid worldId", async () => {
    handle = await startRestTransport({ port: 0, token: ADMIN_TOKEN, baseDir: makeTempDir() });
    const res = await fetch(`${getBaseUrl()}/api/worlds`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ worldId: "../../evil", name: "Evil" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/worlds returns 401 without admin token", async () => {
    handle = await startRestTransport({ port: 0, token: ADMIN_TOKEN, baseDir: makeTempDir() });
    const res = await fetch(`${getBaseUrl()}/api/worlds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worldId: "story-2", name: "Story Two" }),
    });
    expect(res.status).toBe(401);
  });

  it("DELETE /api/worlds/:id removes the world (204)", async () => {
    handle = await startRestTransport({ port: 0, token: ADMIN_TOKEN, baseDir: makeTempDir() });
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` };
    await fetch(`${getBaseUrl()}/api/worlds`, {
      method: "POST",
      headers,
      body: JSON.stringify({ worldId: "to-delete", name: "Temp" }),
    });
    const res = await fetch(`${getBaseUrl()}/api/worlds/to-delete`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(204);

    // Verify it's gone from the list
    const listRes = await fetch(`${getBaseUrl()}/api/worlds`, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const listBody = await listRes.json();
    expect(listBody.worlds.some((w: { worldId: string }) => w.worldId === "to-delete")).toBe(false);
  });

  it("DELETE /api/worlds/:id returns 404 for unknown world", async () => {
    handle = await startRestTransport({ port: 0, token: ADMIN_TOKEN, baseDir: makeTempDir() });
    const res = await fetch(`${getBaseUrl()}/api/worlds/nonexistent`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  it("world endpoints require admin token (player token rejected with 403)", async () => {
    handle = await startRestTransport({ port: 0, token: ADMIN_TOKEN, baseDir: makeTempDir() });
    const { playerToken } = await (await fetch(`${getBaseUrl()}/api/players`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({}),
    })).json();

    const res = await fetch(`${getBaseUrl()}/api/worlds`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${playerToken}` },
      body: JSON.stringify({ worldId: "sneaky", name: "Sneaky" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("REST Transport — extractionProvider option", () => {
  it("accepts an optional extractionProvider in options", async () => {
    const calls: string[] = [];
    handle = await startRestTransport({
      port: 0,
      baseDir: makeTempDir(),
      extractionProvider: {
        name: "test-mock",
        complete: async (prompt: string) => { calls.push(prompt); return '{"facts":[]}'; },
      },
    });
    const res = await fetch(`${getBaseUrl()}/api/health`);
    expect(res.status).toBe(200);
    // Provider is accepted but not invoked on a health check.
    expect(calls).toHaveLength(0);
  });
});

/**
 * v2 path scaffolding — TIR+QDP only fires on player-v2 tokens (worldDb-scoped).
 * In no-auth mode `activeWorldDb` is null and requests fall to the legacy
 * KnowledgeStore branch. To exercise the new code through HTTP, we must:
 *   1. Boot the server with an admin token
 *   2. Mint a v2 player token via POST /api/players + X-Strata-World header
 *   3. Use that token's bearer auth for /api/agents/* calls
 */
async function bootV2Server(opts: { mockProvider?: { name: string; complete: () => Promise<string> } } = {}) {
  const ADMIN = "a".repeat(32);
  const baseDir = makeTempDir();
  handle = await startRestTransport({
    port: 0,
    token: ADMIN,
    baseDir,
    extractionProvider: opts.mockProvider,
  });
  const base = getBaseUrl();
  const mintRes = await fetch(`${base}/api/players`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ADMIN}`,
      "X-Strata-World": "default",
    },
    body: JSON.stringify({}),
  });
  const { playerToken } = await mintRes.json();
  // Open the world DB directly so tests can seed it via NpcMemoryEngine.
  // The world "default" is always at {baseDir}/worlds/default/world.db.
  const { default: Database } = await import("better-sqlite3");
  const { join: pathJoin } = await import("node:path");
  const worldDb = new Database(pathJoin(baseDir, "worlds", "default", "world.db"));
  const agentId = "goran";
  return {
    base,
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${playerToken}` },
    worldDb,
    agentId,
  };
}

describe("REST Transport — turn indexing on /store (Spec 2026-04-26)", () => {
  const mockProvider = { name: "test-mock", complete: async () => '{"facts":[]}' };

  it("writes a turn row when body.extract === true (verified via search)", async () => {
    const { base, headers } = await bootV2Server({ mockProvider });

    const res = await fetch(`${base}/api/agents/goran/store`, {
      method: "POST", headers,
      body: JSON.stringify({ memory: "the password is moonstone", extract: true }),
    });
    expect(res.status).toBe(200);

    const search = await fetch(`${base}/api/agents/goran/search`, {
      method: "POST", headers,
      body: JSON.stringify({ query: "moonstone", limit: 5 }),
    });
    const body = await search.json();
    expect(body.results.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT crash when body.extract is missing (seed-mode path)", async () => {
    const { base, headers } = await bootV2Server({ mockProvider });
    const res = await fetch(`${base}/api/agents/goran/store`, {
      method: "POST", headers,
      body: JSON.stringify({ memory: "seed fact, no extract flag" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("REST Transport — recall TIR + QDP (Spec 2026-04-26)", () => {
  const mockProvider = { name: "test-mock", complete: async () => '{"facts":[]}' };

  it("recall surfaces turn content from extract:true writes (proves dual-index wiring)", async () => {
    const { base, headers } = await bootV2Server({ mockProvider });

    // Live conversational turn — should land in npc_turns AND surface via the
    // turn-level FTS5 lane in the new /recall pipeline.
    await fetch(`${base}/api/agents/goran/store`, {
      method: "POST", headers,
      body: JSON.stringify({ memory: "the password to the back room is moonstone", extract: true }),
    });

    const res = await fetch(`${base}/api/agents/goran/recall`, {
      method: "POST", headers,
      body: JSON.stringify({ situation: "what was the password", limit: 5 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const joined = body.context.map((c: { text: string }) => c.text).join(" || ");
    expect(joined).toContain("moonstone");
    // The new pipeline tags fused candidates with their source. Turn-source
    // confidence is the RRF score — a small float, not the legacy importance/100.
    const sources = new Set(body.context.map((c: { source: string }) => c.source));
    expect(sources.has("npc-turn") || sources.has("world-fts5")).toBe(true);
  });

  it("recall QDP drops near-duplicates", async () => {
    const { base, headers } = await bootV2Server({ mockProvider });

    for (const text of [
      "the password is moonstone",
      "the password is moonstone",
      "the password was moonstone",
    ]) {
      await fetch(`${base}/api/agents/goran/store`, {
        method: "POST", headers,
        body: JSON.stringify({ memory: text, extract: true }),
      });
    }
    const res = await fetch(`${base}/api/agents/goran/recall`, {
      method: "POST", headers,
      body: JSON.stringify({ situation: "password", limit: 5 }),
    });
    const body = await res.json();
    const moonstoneHits = body.context.filter((c: { text: string }) => c.text.includes("moonstone"));
    expect(moonstoneHits.length).toBeLessThanOrEqual(2);
  });

  it("recall QDP drops query-irrelevant noise", async () => {
    const { base, headers } = await bootV2Server({ mockProvider });

    await fetch(`${base}/api/agents/goran/store`, {
      method: "POST", headers,
      body: JSON.stringify({ memory: "the password is moonstone", extract: true }),
    });
    await fetch(`${base}/api/agents/goran/store`, {
      method: "POST", headers,
      body: JSON.stringify({ memory: "completely unrelated trivia about ferrets", extract: true }),
    });
    const res = await fetch(`${base}/api/agents/goran/recall`, {
      method: "POST", headers,
      body: JSON.stringify({ situation: "password moonstone", limit: 5 }),
    });
    const body = await res.json();
    const texts = body.context.map((c: { text: string }) => c.text);
    expect(texts.some((t: string) => t.includes("moonstone"))).toBe(true);
    expect(texts.some((t: string) => t.includes("ferrets"))).toBe(false);
  });

  it("recall response shape unchanged: { context, summary }", async () => {
    const { base, headers } = await bootV2Server({ mockProvider });
    const res = await fetch(`${base}/api/agents/goran/recall`, {
      method: "POST", headers,
      body: JSON.stringify({ situation: "anything", limit: 5 }),
    });
    const body = await res.json();
    expect(Array.isArray(body.context)).toBe(true);
    expect(typeof body.summary).toBe("string");
  });

  it("recall response includes createdAt and speaker on each context item", async () => {
    const { base, headers } = await bootV2Server({ mockProvider });
    await fetch(`${base}/api/agents/goran/store`, {
      method: "POST", headers,
      body: JSON.stringify({ memory: "the password is moonstone", extract: true, speaker: "player" }),
    });
    const res = await fetch(`${base}/api/agents/goran/recall`, {
      method: "POST", headers,
      body: JSON.stringify({ situation: "password", limit: 5 }),
    });
    const body = await res.json();
    expect(body.context.length).toBeGreaterThanOrEqual(1);
    for (const item of body.context) {
      expect(typeof item.createdAt).toBe("number");
      expect(item.createdAt).toBeGreaterThan(0);
      expect(["player", "npc"]).toContain(item.speaker);
    }
  });

  it("recall passes through speaker:'npc' from a turn stored by an NPC", async () => {
    const { base, headers } = await bootV2Server({ mockProvider });
    await fetch(`${base}/api/agents/goran/store`, {
      method: "POST", headers,
      body: JSON.stringify({ memory: "I am Goran the blacksmith", extract: true, speaker: "npc" }),
    });
    const res = await fetch(`${base}/api/agents/goran/recall`, {
      method: "POST", headers,
      body: JSON.stringify({ situation: "Goran blacksmith", limit: 5 }),
    });
    const body = await res.json();
    const npcSpeakerItems = body.context.filter((c: { speaker: string }) => c.speaker === "npc");
    expect(npcSpeakerItems.length).toBeGreaterThanOrEqual(1);
  });

  it("recall fact-source items default speaker:'player' when no self-utterance tag", async () => {
    const { base, headers } = await bootV2Server({ mockProvider });
    // Seed-mode write — no extract:true, lands in npc_memories without self-utterance tag.
    await fetch(`${base}/api/agents/goran/store`, {
      method: "POST", headers,
      body: JSON.stringify({ memory: "the back-room password", tags: ["seed"] }),
    });
    const res = await fetch(`${base}/api/agents/goran/recall`, {
      method: "POST", headers,
      body: JSON.stringify({ situation: "back-room password", limit: 5 }),
    });
    const body = await res.json();
    const factItems = body.context.filter((c: { source: string }) => c.source === "world-fts5");
    expect(factItems.length).toBeGreaterThanOrEqual(1);
    for (const item of factItems) {
      expect(item.speaker).toBe("player");
    }
  });

  it("recall excludes superseded facts when Spec 2026-04-28 conflict resolution applies", async () => {
    const { base, headers, worldDb, agentId } = await bootV2Server({ mockProvider });
    // Direct-write two facts via NpcMemoryEngine (LLM-free path).
    const { NpcMemoryEngine } = await import("../../src/transports/npc-memory-engine.js");
    const engine = new NpcMemoryEngine(worldDb, agentId);
    const id1 = engine.add({ content: "horse is Silvermist", tags: ["extracted", "semantic"], importance: 70, subjectKey: "player", predicateKey: "current_hors" });
    const id2 = engine.add({ content: "horse is Shadowfax",  tags: ["extracted", "semantic"], importance: 70, subjectKey: "player", predicateKey: "current_hors" });
    engine.markSupersededByKey({ npcId: agentId, subjectKey: "player", predicateKey: "current_hors", excludeId: id2, supersededBy: id2 });

    const res = await fetch(`${base}/api/agents/${agentId}/recall`, {
      method: "POST", headers,
      body: JSON.stringify({ situation: "horse", limit: 5 }),
    });
    const body = await res.json();
    const texts = body.context.map((c: { text: string }) => c.text);
    expect(texts).toContain("horse is Shadowfax");
    expect(texts).not.toContain("horse is Silvermist");
    void id1; // referenced for clarity; the assertion above proves it's filtered
  });

  it("recall returns NULL-key facts unchanged when no supersede applies", async () => {
    const { base, headers, worldDb, agentId } = await bootV2Server({ mockProvider });
    const { NpcMemoryEngine } = await import("../../src/transports/npc-memory-engine.js");
    const engine = new NpcMemoryEngine(worldDb, agentId);
    engine.add({ content: "a generic fact about the village", tags: ["seed"], importance: 50 });   // NULL keys

    const res = await fetch(`${base}/api/agents/${agentId}/recall`, {
      method: "POST", headers,
      body: JSON.stringify({ situation: "village", limit: 5 }),
    });
    const body = await res.json();
    const texts = body.context.map((c: { text: string }) => c.text);
    expect(texts).toContain("a generic fact about the village");
  });
});

// ── Issue #3 fixes ────────────────────────────────────────────────────────

describe("REST Transport — issue #3-A: legacy /api/players re-mints token on re-fetch", () => {
  const ADMIN_TOKEN = "a".repeat(32);

  it("re-fetching the same externalId on the legacy path returns a non-empty playerToken", async () => {
    handle = await startRestTransport({
      port: 0,
      token: ADMIN_TOKEN,
      baseDir: makeTempDir(),
    });
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    };
    const body = JSON.stringify({ externalId: "device:refetch:test" });

    // First call — creates the player
    const first = await (
      await fetch(`${getBaseUrl()}/api/players`, { method: "POST", headers, body })
    ).json();
    expect(first.playerToken).toMatch(/^pt_[0-9a-f]{32}$/);

    // Second call — re-fetch by same externalId (legacy path, no X-Strata-World)
    const second = await (
      await fetch(`${getBaseUrl()}/api/players`, { method: "POST", headers, body })
    ).json();
    expect(second.isNew).toBe(false);
    expect(second.playerId).toBe(first.playerId);
    // BUG (pre-fix): second.playerToken was "" — clients lost access after restart
    expect(second.playerToken).toMatch(/^pt_[0-9a-f]{32}$/);
  });
});

describe("REST Transport — issue #3-B: GET /api/players/:playerId returns real memoryCount", () => {
  const ADMIN_TOKEN = "a".repeat(32);

  it("memoryCount reflects stored memories for that player", async () => {
    handle = await startRestTransport({
      port: 0,
      token: ADMIN_TOKEN,
      baseDir: makeTempDir(),
    });
    const base = getBaseUrl();

    // Provision a player
    const { playerId, playerToken } = await (
      await fetch(`${base}/api/players`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify({}),
      })
    ).json();

    // Store one memory through their token
    await fetch(`${base}/api/agents/goran/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${playerToken}` },
      body: JSON.stringify({ memory: "test memory for count check", type: "fact" }),
    });

    // GET player detail and assert memoryCount is wired
    const res = await fetch(`${base}/api/players/${playerId}`, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const detail = await res.json();
    // BUG (pre-fix): memoryCount was null
    expect(detail.memoryCount).toBe(1);
  });

  it("npcCount reflects the number of distinct agents the player has interacted with", async () => {
    handle = await startRestTransport({
      port: 0,
      token: ADMIN_TOKEN,
      baseDir: makeTempDir(),
    });
    const base = getBaseUrl();

    const { playerId, playerToken } = await (
      await fetch(`${base}/api/players`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify({}),
      })
    ).json();

    // Store memories for two distinct NPCs
    for (const npc of ["goran", "brynn"]) {
      await fetch(`${base}/api/agents/${npc}/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${playerToken}` },
        body: JSON.stringify({ memory: `memory for ${npc}`, type: "fact" }),
      });
    }

    const res = await fetch(`${base}/api/players/${playerId}`, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const detail = await res.json();
    // BUG (pre-fix): npcCount was null
    expect(detail.npcCount).toBe(2);
  });
});

describe("REST Transport — issue #3-C: token rotation grace period", () => {
  const ADMIN_TOKEN = "a".repeat(32);

  it("old token still verifies after rotating to a new secret (STRATA_TOKEN_SECRET_PREVIOUS)", async () => {
    const SECRET_X = "secret-x-" + "a".repeat(23); // ≥32 chars not required for token secret
    const SECRET_Y = "secret-y-" + "b".repeat(23);

    const prevSecret = process.env.STRATA_TOKEN_SECRET;
    const prevPrev = process.env.STRATA_TOKEN_SECRET_PREVIOUS;

    try {
      // Boot with secret X
      process.env.STRATA_TOKEN_SECRET = SECRET_X;
      delete process.env.STRATA_TOKEN_SECRET_PREVIOUS;

      handle = await startRestTransport({ port: 0, token: ADMIN_TOKEN, baseDir: makeTempDir() });
      const base = getBaseUrl();

      // Mint a world + player (v2 HMAC token signed with SECRET_X)
      await fetch(`${base}/api/worlds`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify({ worldId: "rotation-test", name: "Rotation" }),
      });
      const { playerToken: oldToken } = await (
        await fetch(`${base}/api/players`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ADMIN_TOKEN}`,
            "X-Strata-World": "rotation-test",
          },
          body: JSON.stringify({}),
        })
      ).json();

      // Verify oldToken works before rotation
      const beforeRotation = await fetch(`${base}/api/agents/goran/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${oldToken}` },
        body: JSON.stringify({ memory: "pre-rotation memory", type: "fact" }),
      });
      expect(beforeRotation.status).toBe(200);

      // Close and restart with Y as current, X as previous
      await handle.close();
      handle = undefined;

      process.env.STRATA_TOKEN_SECRET = SECRET_Y;
      process.env.STRATA_TOKEN_SECRET_PREVIOUS = SECRET_X;

      handle = await startRestTransport({ port: 0, token: ADMIN_TOKEN, baseDir: makeTempDir() });
      const base2 = getBaseUrl();

      // Recreate world on the new server instance
      await fetch(`${base2}/api/worlds`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify({ worldId: "rotation-test", name: "Rotation" }),
      });

      // BUG (pre-fix): oldToken (signed with X) would fail when only Y is checked
      const afterRotation = await fetch(`${base2}/api/agents/goran/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${oldToken}` },
        body: JSON.stringify({ memory: "post-rotation memory via old token", type: "fact" }),
      });
      expect(afterRotation.status).toBe(200);
    } finally {
      if (prevSecret !== undefined) process.env.STRATA_TOKEN_SECRET = prevSecret;
      else delete process.env.STRATA_TOKEN_SECRET;
      if (prevPrev !== undefined) process.env.STRATA_TOKEN_SECRET_PREVIOUS = prevPrev;
      else delete process.env.STRATA_TOKEN_SECRET_PREVIOUS;
    }
  });

  it("new tokens signed with current secret work normally after rotation", async () => {
    const SECRET_X = "secret-x-" + "a".repeat(23);
    const SECRET_Y = "secret-y-" + "b".repeat(23);

    const prevSecret = process.env.STRATA_TOKEN_SECRET;
    const prevPrev = process.env.STRATA_TOKEN_SECRET_PREVIOUS;

    try {
      process.env.STRATA_TOKEN_SECRET = SECRET_Y;
      process.env.STRATA_TOKEN_SECRET_PREVIOUS = SECRET_X;

      handle = await startRestTransport({ port: 0, token: ADMIN_TOKEN, baseDir: makeTempDir() });
      const base = getBaseUrl();

      // Mint a new token (signed with Y)
      const { playerToken: newToken } = await (
        await fetch(`${base}/api/players`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ADMIN_TOKEN}`,
            "X-Strata-World": "default",
          },
          body: JSON.stringify({}),
        })
      ).json();

      expect(newToken).toMatch(/^strata_v2\./);

      const res = await fetch(`${base}/api/agents/goran/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${newToken}` },
        body: JSON.stringify({ memory: "new token works fine", type: "fact" }),
      });
      expect(res.status).toBe(200);
    } finally {
      if (prevSecret !== undefined) process.env.STRATA_TOKEN_SECRET = prevSecret;
      else delete process.env.STRATA_TOKEN_SECRET;
      if (prevPrev !== undefined) process.env.STRATA_TOKEN_SECRET_PREVIOUS = prevPrev;
      else delete process.env.STRATA_TOKEN_SECRET_PREVIOUS;
    }
  });
});
