// strata/tests/embeddings/provider-factory.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createEmbeddingProvider } from "../../src/extensions/vector-search/embedding-provider.js";

afterEach(() => { delete process.env.STRATA_EMBEDDING_PROVIDER; delete process.env.GEMINI_API_KEY; });

describe("createEmbeddingProvider dispatch", () => {
  it("returns a Gemini provider (3072, supportsQuantization=true) when a key is set", () => {
    process.env.GEMINI_API_KEY = "test-key";
    const p = createEmbeddingProvider();
    expect(p.modelName).toBe("gemini-embedding-001");
    expect(p.dimensions).toBe(3072);
    expect(p.supportsQuantization).toBe(true);
  });

  it("throws a clear error for local provider until weights are present", () => {
    process.env.STRATA_EMBEDDING_PROVIDER = "local";
    expect(() => createEmbeddingProvider()).toThrow(/local embedding model/i);
  });
});
