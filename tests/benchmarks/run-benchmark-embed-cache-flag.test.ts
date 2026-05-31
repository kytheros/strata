import { describe, it, expect } from "vitest";
import { resolveEmbeddingCacheEnabled } from "../../benchmarks/longmemeval/run-benchmark.js";

describe("resolveEmbeddingCacheEnabled", () => {
  it("enabled by default", () => {
    expect(resolveEmbeddingCacheEnabled([], {})).toBe(true);
  });
  it("disabled by --no-embedding-cache flag", () => {
    expect(resolveEmbeddingCacheEnabled(["--no-embedding-cache"], {})).toBe(false);
  });
  it("disabled by LONGMEMEVAL_NO_EMBED_CACHE=1 env", () => {
    expect(resolveEmbeddingCacheEnabled([], { LONGMEMEVAL_NO_EMBED_CACHE: "1" })).toBe(false);
  });
});
