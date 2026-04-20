import { describe, it, expect, afterEach, vi } from "vitest";
import { startRestTransport, type RestTransportHandle } from "../../src/transports/rest-transport.js";
import type { LlmProvider } from "../../src/extensions/llm-extraction/llm-provider.js";
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import { join } from "path";

let handle: RestTransportHandle | undefined;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "strata-rest-extract-"));
}

function baseUrl(): string {
  const addr = handle!.server.address();
  if (typeof addr === "object" && addr !== null) return `http://127.0.0.1:${addr.port}`;
  throw new Error("no address");
}

function mockProvider(facts: Array<{ text: string; type: string; importance?: number }>): LlmProvider {
  return { name: "mock", complete: vi.fn(async () => JSON.stringify({ facts })) };
}

afterEach(async () => {
  if (handle) { await handle.close(); handle = undefined; }
});

describe("POST /store extract:true", () => {
  it("writes verbatim + extracted rows and returns extractedCount", async () => {
    const provider = mockProvider([
      { text: "player is named Mike", type: "semantic", importance: 70 },
      { text: "player wants twenty spears", type: "episodic", importance: 60 },
    ]);
    handle = await startRestTransport({ port: 0, baseDir: tempDir(), extractionProvider: provider });
    const res = await fetch(`${baseUrl()}/api/agents/goran/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        memory: "Player said: 'my name is Mike and I want twenty spears'",
        tags: ["dialogue"],
        extract: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stored).toBe(true);
    expect(body.extractedCount).toBe(2);
    expect(provider.complete).toHaveBeenCalledOnce();

    // Verify the extracted rows are searchable.
    const searchRes = await fetch(`${baseUrl()}/api/agents/goran/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "Mike", limit: 10 }),
    });
    const searchBody = await searchRes.json();
    const texts = (searchBody.results ?? []).map((r: { text: string }) => r.text);
    expect(texts).toContain("player is named Mike");
  });

  it("skips extraction when extract:false (default)", async () => {
    const provider = mockProvider([{ text: "should not appear", type: "semantic" }]);
    handle = await startRestTransport({ port: 0, baseDir: tempDir(), extractionProvider: provider });
    const res = await fetch(`${baseUrl()}/api/agents/goran/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memory: "a plain statement", tags: ["dialogue"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stored).toBe(true);
    expect(body.extractedCount ?? 0).toBe(0);
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("returns extractedCount:0 when provider throws and verbatim row still persists", async () => {
    const provider: LlmProvider = {
      name: "broken",
      complete: vi.fn(async () => { throw new Error("provider boom"); }),
    };
    handle = await startRestTransport({ port: 0, baseDir: tempDir(), extractionProvider: provider });
    const res = await fetch(`${baseUrl()}/api/agents/goran/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memory: "I am Alex the paladin", extract: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stored).toBe(true);
    expect(body.extractedCount).toBe(0);

    const searchRes = await fetch(`${baseUrl()}/api/agents/goran/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "Alex", limit: 5 }),
    });
    const texts = (await searchRes.json()).results.map((r: { text: string }) => r.text);
    expect(texts.some((t: string) => t.includes("Alex"))).toBe(true);
  });

  it("tags extracted rows with [extracted, <type>] in addition to user tags", async () => {
    const provider = mockProvider([{ text: "player is named Mike", type: "semantic", importance: 70 }]);
    handle = await startRestTransport({ port: 0, baseDir: tempDir(), extractionProvider: provider });
    await fetch(`${baseUrl()}/api/agents/goran/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memory: "my name is Mike", tags: ["dialogue"], extract: true }),
    });
    const searchRes = await fetch(`${baseUrl()}/api/agents/goran/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "Mike", limit: 10 }),
    });
    const rows = (await searchRes.json()).results as Array<{ text: string; tags: string[] }>;
    const extracted = rows.find(r => r.text === "player is named Mike");
    expect(extracted).toBeDefined();
    expect(extracted!.tags).toContain("dialogue");
    expect(extracted!.tags).toContain("extracted");
    expect(extracted!.tags).toContain("semantic");
  });

  it("respects STRATA_REST_EXTRACT_ENABLED=false env flag", async () => {
    const original = process.env.STRATA_REST_EXTRACT_ENABLED;
    process.env.STRATA_REST_EXTRACT_ENABLED = "false";
    try {
      const provider = mockProvider([{ text: "x", type: "semantic" }]);
      handle = await startRestTransport({ port: 0, baseDir: tempDir(), extractionProvider: provider });
      const res = await fetch(`${baseUrl()}/api/agents/goran/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memory: "some statement", extract: true }),
      });
      const body = await res.json();
      expect(body.extractedCount ?? 0).toBe(0);
      expect(provider.complete).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env.STRATA_REST_EXTRACT_ENABLED;
      else process.env.STRATA_REST_EXTRACT_ENABLED = original;
    }
  });

  it("respects STRATA_REST_EXTRACT_MAX_ITEMS cap", async () => {
    const original = process.env.STRATA_REST_EXTRACT_MAX_ITEMS;
    process.env.STRATA_REST_EXTRACT_MAX_ITEMS = "2";
    try {
      const provider = mockProvider([
        { text: "f1", type: "semantic" }, { text: "f2", type: "semantic" },
        { text: "f3", type: "semantic" }, { text: "f4", type: "semantic" },
      ]);
      handle = await startRestTransport({ port: 0, baseDir: tempDir(), extractionProvider: provider });
      const res = await fetch(`${baseUrl()}/api/agents/goran/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memory: "a long utterance with many facts", extract: true }),
      });
      const body = await res.json();
      expect(body.extractedCount).toBe(2);
    } finally {
      if (original === undefined) delete process.env.STRATA_REST_EXTRACT_MAX_ITEMS;
      else process.env.STRATA_REST_EXTRACT_MAX_ITEMS = original;
    }
  });
});
