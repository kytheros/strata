// strata/tests/embeddings/openai-compatible-embedder.test.ts
import { describe, it, expect } from "vitest";
import { OpenAiCompatibleProvider } from "../../src/extensions/embeddings/openai-compatible-embedder.js";

describe("OpenAiCompatibleProvider", () => {
  it("omits Authorization when no apiKey, and validates response length", async () => {
    let sawAuth = true;
    const fakeFetch = async (_u: string, init: any) => {
      sawAuth = "Authorization" in (init.headers || {});
      return { ok: true, json: async () => ({ data: [{ embedding: new Array(1536).fill(0.1) }] }) } as any;
    };
    const p = new OpenAiCompatibleProvider({ baseUrl: "http://localhost:1234/v1", model: "m", dimensions: 1536, fetchFn: fakeFetch });
    const v = await p.embed("hi", "RETRIEVAL_QUERY");
    expect(sawAuth).toBe(false);
    expect(v.length).toBe(1536);
  });

  it("rejects a response whose embedding length != configured dimensions", async () => {
    const fakeFetch = async () => ({ ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }) } as any);
    const p = new OpenAiCompatibleProvider({ baseUrl: "http://x/v1", model: "m", dimensions: 1536, fetchFn: fakeFetch });
    await expect(p.embed("hi")).rejects.toThrow(/dimension/i);
  });
});
