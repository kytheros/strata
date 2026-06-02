// strata/tests/embeddings/active-model.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { resolveActiveEmbeddingModel } from "../../src/extensions/embeddings/active-model.js";

afterEach(() => {
  delete process.env.STRATA_EMBEDDING_PROVIDER;
  delete process.env.STRATA_EMBEDDING_MODEL;
});

describe("resolveActiveEmbeddingModel", () => {
  it("defaults to gemini-embedding-001 / 3072 when nothing is set", () => {
    const a = resolveActiveEmbeddingModel();
    expect(a.provider).toBe("gemini");
    expect(a.model).toBe("gemini-embedding-001");
    expect(a.dimensions).toBe(3072);
  });

  it("honours STRATA_EMBEDDING_PROVIDER=local with nomic defaults", () => {
    process.env.STRATA_EMBEDDING_PROVIDER = "local";
    const a = resolveActiveEmbeddingModel();
    expect(a.provider).toBe("local");
    expect(a.model).toBe("nomic-embed-text-v1.5");
    expect(a.dimensions).toBe(768);
  });
});
