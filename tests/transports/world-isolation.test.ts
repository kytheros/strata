/**
 * Cross-world isolation test.
 *
 * Verifies that memories, profiles, and relationships stored in one world are
 * invisible to players (or admins) operating in a different world.
 *
 * Scenarios:
 *   1. PC-A (story-1) stores memory on Goran → PC-B (story-2) recall returns empty.
 *   2. PC-A's v2 token with X-Strata-World: story-2 header → token worldId wins (story-1 is used).
 *   3. Admin deletes story-1 → PC-A's next request → 403.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRestTransport } from "../../src/transports/rest-transport.js";
import type { RestTransportHandle } from "../../src/transports/rest-transport.js";

const ADMIN_TOKEN = "b".repeat(32);

let dataDir: string;
let transport: RestTransportHandle;
let baseUrl: string;

async function api(
  method: string,
  path: string,
  body: unknown,
  token?: string,
  extraHeaders?: Record<string, string>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (extraHeaders) Object.assign(headers, extraHeaders);
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: method !== "GET" && method !== "DELETE" ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: json };
}

/** Provision a player into a specific world via X-Strata-World header. Returns v2 token. */
async function provisionIntoWorld(worldId: string): Promise<string> {
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
    throw new Error(`provisionIntoWorld(${worldId}) failed: ${JSON.stringify(data)}`);
  }
  return data.playerToken as string;
}

/** Create a world and return its record. */
async function createWorld(worldId: string): Promise<void> {
  const r = await api("POST", "/api/worlds", { worldId, name: worldId }, ADMIN_TOKEN);
  if (r.status !== 201) throw new Error(`createWorld(${worldId}) failed: ${JSON.stringify(r.body)}`);
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "strata-isolation-"));
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

describe("world-isolation: memories do not leak across worlds", () => {
  it("PC-A (story-1) stores memory on Goran; PC-B (story-2) recall returns empty", async () => {
    await createWorld("story-1");
    await createWorld("story-2");

    const tokA = await provisionIntoWorld("story-1");
    const tokB = await provisionIntoWorld("story-2");

    // PC-A stores a memory on Goran in story-1
    const storeRes = await api(
      "POST", "/api/agents/goran/store",
      { memory: "Goran revealed the secret passage under the keep.", type: "fact" },
      tokA
    );
    expect(storeRes.status).toBe(200);
    expect(storeRes.body.stored).toBe(true);

    // PC-B recalls from Goran in story-2 — must be empty (no cross-world leak)
    const recallRes = await api(
      "POST", "/api/agents/goran/recall",
      { situation: "secret passage under keep" },
      tokB
    );
    expect(recallRes.status).toBe(200);
    const context = recallRes.body.context as Array<{ text: string }>;
    expect(Array.isArray(context)).toBe(true);
    expect(context.length).toBe(0);
  });

  it("PC-A (story-1) search Goran — PC-B (story-2) search returns empty", async () => {
    await createWorld("story-1");
    await createWorld("story-2");

    const tokA = await provisionIntoWorld("story-1");
    const tokB = await provisionIntoWorld("story-2");

    // PC-A stores memory in story-1
    await api(
      "POST", "/api/agents/goran/store",
      { memory: "Unique secret xylophone cantaloupe memory for isolation test." },
      tokA
    );

    // PC-B searches story-2 — must return empty
    const searchRes = await api(
      "POST", "/api/agents/goran/search",
      { query: "xylophone cantaloupe" },
      tokB
    );
    expect(searchRes.status).toBe(200);
    const results = searchRes.body.results as Array<{ text: string }>;
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  });

  it("X-Strata-World header is ignored for player v2 tokens — token worldId wins", async () => {
    await createWorld("story-1");
    await createWorld("story-2");

    const tokA = await provisionIntoWorld("story-1");

    // PC-A stores a memory in story-1 (no hyphens — FTS5 treats hyphens as NOT operators)
    await api(
      "POST", "/api/agents/goran/store",
      { memory: "Token worldId wins marker phrase for isolation test verification." },
      tokA
    );

    // PC-A sends a recall with X-Strata-World: story-2 header — token worldId (story-1) must win.
    // The X-Strata-World header is only honoured for admin tokens; for player-v2 it's ignored.
    const recallRes = await fetch(`${baseUrl}/api/agents/goran/recall`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${tokA}`,
        "X-Strata-World": "story-2", // attempt to redirect to story-2
      },
      body: JSON.stringify({ situation: "marker phrase isolation verification" }),
    });
    expect(recallRes.status).toBe(200);
    const body = (await recallRes.json()) as { context: Array<{ text: string }> };
    // Should still find the memory because token says story-1, not story-2
    expect(body.context.length).toBeGreaterThan(0);
    expect(body.context.some((c) => c.text.includes("marker phrase"))).toBe(true);
  });

  it("admin deletes story-1 — PC-A next request returns 403", async () => {
    await createWorld("story-1");
    const tokA = await provisionIntoWorld("story-1");

    // Confirm PC-A can store before deletion
    const beforeRes = await api(
      "POST", "/api/agents/goran/store",
      { memory: "Pre-deletion memory." },
      tokA
    );
    expect(beforeRes.status).toBe(200);

    // Admin deletes story-1
    const deleteRes = await fetch(`${baseUrl}/api/worlds/story-1`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${ADMIN_TOKEN}` },
    });
    expect(deleteRes.status).toBe(204);

    // PC-A's next request must fail with 403 (world no longer exists)
    const afterRes = await api(
      "POST", "/api/agents/goran/recall",
      { situation: "forge" },
      tokA
    );
    expect(afterRes.status).toBe(403);
    expect(String(afterRes.body.error)).toMatch(/story-1/);
  });
});
