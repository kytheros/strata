import { describe, it, expect, afterEach } from "vitest";
import { configureEmbeddingCache, getEmbeddingCacheStats } from "../../benchmarks/longmemeval/ingest.js";

describe("ingest embedding-cache wiring", () => {
  afterEach(() => configureEmbeddingCache({ enabled: false }));

  it("exposes stats (zeroed) when configured enabled with an in-memory db", () => {
    configureEmbeddingCache({ enabled: true, dbPath: ":memory:" });
    expect(getEmbeddingCacheStats()).toEqual({ hits: 0, misses: 0 });
  });

  it("returns null stats when disabled", () => {
    configureEmbeddingCache({ enabled: false });
    expect(getEmbeddingCacheStats()).toBeNull();
  });
});
