import { describe, it, expect, beforeEach } from "vitest";
import { BM25Index } from "../../src/indexing/bm25.js";

describe("BM25Index", () => {
  let index: BM25Index;

  beforeEach(() => {
    index = new BM25Index();
  });

  it("should return empty results for empty index", () => {
    expect(index.search(["test"])).toEqual([]);
  });

  it("should find documents by matching terms", () => {
    index.addDocument("doc-0", ["docker", "network", "error"]);
    index.addDocument("doc-1", ["react", "component", "render"]);
    index.addDocument("doc-2", ["docker", "container", "build"]);

    const results = index.search(["docker"]);
    expect(results.length).toBe(2);
    expect(results.map((r) => r.docId)).toContain("doc-0");
    expect(results.map((r) => r.docId)).toContain("doc-2");
  });

  it("should rank by relevance", () => {
    index.addDocument("doc-0", ["docker", "docker", "network", "error"]);
    index.addDocument("doc-1", ["docker", "react"]);

    const results = index.search(["docker"]);
    // Doc 0 has higher TF for "docker"
    expect(results[0].docId).toBe("doc-0");
  });

  it("should handle multi-term queries", () => {
    index.addDocument("doc-0", ["docker", "network", "error"]);
    index.addDocument("doc-1", ["react", "network", "component"]);
    index.addDocument("doc-2", ["docker", "container"]);

    const results = index.search(["docker", "network"]);
    // Doc 0 matches both terms
    expect(results[0].docId).toBe("doc-0");
  });

  it("should remove documents", () => {
    index.addDocument("doc-0", ["docker", "network"]);
    index.addDocument("doc-1", ["docker", "container"]);

    index.removeDocument("doc-0");

    const results = index.search(["network"]);
    expect(results.length).toBe(0);

    const dockerResults = index.search(["docker"]);
    expect(dockerResults.length).toBe(1);
    expect(dockerResults[0].docId).toBe("doc-1");
  });

  it("should serialize and deserialize", () => {
    index.addDocument("doc-0", ["hello", "world"]);
    index.addDocument("doc-1", ["foo", "bar"]);

    const serialized = index.serialize();
    const restored = BM25Index.deserialize(serialized);

    const results = restored.search(["hello"]);
    expect(results.length).toBe(1);
    expect(results[0].docId).toBe("doc-0");
    expect(restored.getDocumentCount()).toBe(2);
  });

  it("should use docTerms for fast removal", () => {
    // Add many documents with varied terms
    for (let i = 0; i < 100; i++) {
      index.addDocument(`doc-${i}`, [`term-${i}`, "common", `unique-${i % 10}`]);
    }
    expect(index.getDocumentCount()).toBe(100);

    // Removal should be fast (O(terms-in-doc) not O(vocabulary))
    const start = performance.now();
    index.removeDocument("doc-50");
    const elapsed = performance.now() - start;

    expect(index.getDocumentCount()).toBe(99);
    expect(elapsed).toBeLessThan(10); // Should be sub-millisecond
  });
});
