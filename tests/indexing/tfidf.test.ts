import { describe, it, expect, beforeEach } from "vitest";
import { TFIDFIndex } from "../../src/indexing/tfidf.js";

describe("TFIDFIndex", () => {
  let index: TFIDFIndex;

  beforeEach(() => {
    index = new TFIDFIndex();
  });

  it("should return empty results for empty index", () => {
    expect(index.search(["test"])).toEqual([]);
  });

  it("should find documents by cosine similarity", () => {
    index.addDocument("doc-0", ["docker", "network", "error"]);
    index.addDocument("doc-1", ["react", "component", "render"]);
    index.addDocument("doc-2", ["docker", "container", "build"]);

    const results = index.search(["docker", "error"]);
    expect(results.length).toBeGreaterThan(0);
    // Doc 0 should be most similar (shares both terms)
    expect(results[0].docId).toBe("doc-0");
  });

  it("should handle single-term queries", () => {
    index.addDocument("doc-0", ["alpha", "beta"]);
    index.addDocument("doc-1", ["gamma", "delta"]);

    const results = index.search(["alpha"]);
    expect(results.length).toBe(1);
    expect(results[0].docId).toBe("doc-0");
  });

  it("should remove documents", () => {
    index.addDocument("doc-0", ["test", "doc"]);
    index.addDocument("doc-1", ["other", "content"]);

    index.removeDocument("doc-0");
    expect(index.getDocumentCount()).toBe(1);

    const results = index.search(["test"]);
    expect(results.length).toBe(0);
  });

  it("should serialize and deserialize", () => {
    index.addDocument("doc-0", ["hello", "world"]);
    index.addDocument("doc-1", ["foo", "bar"]);

    const serialized = index.serialize();
    const restored = TFIDFIndex.deserialize(serialized);

    expect(restored.getDocumentCount()).toBe(2);
    const results = restored.search(["hello"]);
    expect(results.length).toBe(1);
    expect(results[0].docId).toBe("doc-0");
  });
});
