import { describe, it, expect, afterEach } from "vitest";
import { startRestTransport, type RestTransportHandle } from "../../src/transports/rest-transport.js";
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import { join } from "path";

let handle: RestTransportHandle | undefined;

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
    handle = await startRestTransport({ port: 0, token: "secret123", baseDir: makeTempDir() });
    const res = await fetch(`${getBaseUrl()}/api/agents/npc1/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "test" }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts requests with valid bearer token", async () => {
    handle = await startRestTransport({ port: 0, token: "secret123", baseDir: makeTempDir() });
    const res = await fetch(`${getBaseUrl()}/api/agents/npc1/store`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer secret123",
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
