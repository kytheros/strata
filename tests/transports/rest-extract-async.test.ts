import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { startRestTransport, type RestTransportHandle } from "../../src/transports/rest-transport.js";
import type { LlmProvider } from "../../src/extensions/llm-extraction/llm-provider.js";

let dir: string;
let handle: RestTransportHandle;
let base: string;

const fakeProvider: LlmProvider = {
  name: "fake",
  complete: async () =>
    JSON.stringify({
      facts: [
        { text: "player wants three axes", type: "episodic", importance: 70 },
        { text: "player is named alex", type: "semantic", importance: 80 },
      ],
    }),
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "strata-rest-async-"));
  process.env.STRATA_DATA_DIR = dir;
  handle = await startRestTransport({
    port: 0,
    baseDir: dir,
    extractionProvider: fakeProvider,
  });
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => {
  await handle.close();
  rmSync(dir, { recursive: true, force: true });
});

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe("REST /store extract:true (async queue)", () => {
  test("returns extractionQueued:true immediately and worker drains async", async () => {
    const storeRes = await post("/api/agents/goran/store", {
      memory: "Alex wants three axes before dusk",
      tags: ["dialogue"],
      importance: 60,
      extract: true,
    });
    expect(storeRes.status).toBe(200);
    expect(storeRes.json.stored).toBe(true);
    expect(storeRes.json.extractionQueued).toBe(true);
    expect(storeRes.json.extractedCount).toBeUndefined();

    // Verbatim row should be queryable immediately.
    const immediate = await post("/api/agents/goran/search", { query: "axes", limit: 10 });
    expect(immediate.status).toBe(200);
    expect(Array.isArray(immediate.json.results)).toBe(true);
    expect(immediate.json.results.length).toBeGreaterThanOrEqual(1);

    // Poll up to 5s for extracted facts.
    let extracted: any[] = [];
    for (let i = 0; i < 50; i++) {
      const r = await post("/api/agents/goran/search", { query: "alex", limit: 10 });
      extracted = (r.json.results ?? []).filter((x: any) =>
        Array.isArray(x.tags) && x.tags.includes("extracted"),
      );
      if (extracted.length > 0) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    expect(extracted.length).toBeGreaterThanOrEqual(1);
    expect(extracted[0].tags).toContain("extracted");
  }, 10000);

  test("extract:false omits extractionQueued and does not enqueue", async () => {
    const storeRes = await post("/api/agents/goran/store", {
      memory: "Some other utterance",
      extract: false,
    });
    expect(storeRes.status).toBe(200);
    expect(storeRes.json.stored).toBe(true);
    expect(storeRes.json.extractionQueued).toBeUndefined();
  });
});
