import { describe, it, expect, vi } from "vitest";
import { EmbeddingCacheStore, CachedEmbedder, cacheKey } from "../../benchmarks/longmemeval/embedding-cache.js";

function vec(...xs: number[]): Float32Array {
  return Float32Array.from(xs);
}

describe("cacheKey", () => {
  it("differs by model and taskType for identical text", () => {
    const a = cacheKey("m1", "RETRIEVAL_DOCUMENT", "hello");
    const b = cacheKey("m2", "RETRIEVAL_DOCUMENT", "hello");
    const c = cacheKey("m1", "RETRIEVAL_QUERY", "hello");
    const d = cacheKey("m1", "RETRIEVAL_DOCUMENT", "hello");
    expect(new Set([a, b, c]).size).toBe(3);
    expect(a).toBe(d); // deterministic
  });
});

describe("EmbeddingCacheStore", () => {
  it("round-trips a vector byte-identically (in-memory db)", () => {
    const store = new EmbeddingCacheStore(":memory:");
    const v = vec(0.1, -0.2, 0.3);
    store.put("k1", "m1", v);
    const got = store.get("k1");
    expect(got).not.toBeNull();
    expect(Array.from(got!)).toEqual(Array.from(v));
    store.close();
  });

  it("getMany preserves order with nulls for misses", () => {
    const store = new EmbeddingCacheStore(":memory:");
    store.put("a", "m1", vec(1));
    store.put("c", "m1", vec(3));
    const got = store.getMany(["a", "b", "c"]);
    expect(got[0] && Array.from(got[0])).toEqual([1]);
    expect(got[1]).toBeNull();
    expect(got[2] && Array.from(got[2])).toEqual([3]);
    store.close();
  });

  it("tracks hits and misses", () => {
    const store = new EmbeddingCacheStore(":memory:");
    store.put("a", "m1", vec(1));
    store.get("a");      // hit
    store.get("missing"); // miss
    expect(store.stats()).toEqual({ hits: 1, misses: 1 });
    store.close();
  });
});

describe("CachedEmbedder", () => {
  function fakeInner() {
    return {
      dimensions: 3,
      embed: vi.fn(async (t: string) => vec(t.length, 0, 0)),
      embedBatch: vi.fn(async (ts: string[]) => ts.map((t) => vec(t.length, 0, 0))),
    };
  }

  it("misses then hits: inner.embedBatch only called for uncached texts", async () => {
    const store = new EmbeddingCacheStore(":memory:");
    const inner = fakeInner();
    const ce = new CachedEmbedder(inner, store, "m1");

    const first = await ce.embedBatch(["aa", "bbb"], "RETRIEVAL_DOCUMENT");
    expect(inner.embedBatch).toHaveBeenCalledTimes(1);
    expect(Array.from(first[0])).toEqual([2, 0, 0]);

    inner.embedBatch.mockClear();
    const second = await ce.embedBatch(["aa", "bbb"], "RETRIEVAL_DOCUMENT");
    expect(inner.embedBatch).not.toHaveBeenCalled(); // all cached
    expect(Array.from(second[1])).toEqual(Array.from(first[1])); // byte-identical
    store.close();
  });

  it("partial hit: inner called only with the missing subset, order preserved", async () => {
    const store = new EmbeddingCacheStore(":memory:");
    const inner = fakeInner();
    const ce = new CachedEmbedder(inner, store, "m1");

    await ce.embedBatch(["aa"], "RETRIEVAL_DOCUMENT"); // warm "aa"
    inner.embedBatch.mockClear();
    const out = await ce.embedBatch(["aa", "bbb"], "RETRIEVAL_DOCUMENT");
    expect(inner.embedBatch).toHaveBeenCalledWith(["bbb"], "RETRIEVAL_DOCUMENT");
    expect(Array.from(out[0])).toEqual([2, 0, 0]); // from cache
    expect(Array.from(out[1])).toEqual([3, 0, 0]); // freshly embedded
    store.close();
  });

  it("empty input returns empty without calling inner", async () => {
    const store = new EmbeddingCacheStore(":memory:");
    const inner = fakeInner();
    const ce = new CachedEmbedder(inner, store, "m1");
    expect(await ce.embedBatch([], "RETRIEVAL_DOCUMENT")).toEqual([]);
    expect(inner.embedBatch).not.toHaveBeenCalled();
    store.close();
  });
});
