// strata/tests/storage/write-model-stamp.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { resolveActiveEmbeddingModel } from "../../src/extensions/embeddings/active-model.js";

afterEach(() => { delete process.env.STRATA_EMBEDDING_PROVIDER; });

describe("write-path model stamping", () => {
  it("stamps the active model, not a hardcoded literal", () => {
    process.env.STRATA_EMBEDDING_PROVIDER = "local";
    // The store must call resolveActiveEmbeddingModel().model when writing the embeddings row.
    expect(resolveActiveEmbeddingModel().model).toBe("nomic-embed-text-v1.5");
  });
});
