import { describe, it, expect } from "vitest";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import { VectorSearch } from "../../src/extensions/embeddings/vector-search.js";
import { openDatabase } from "../../src/storage/database.js";

describe("engine embedder/vectorSearch setters", () => {
  it("exposes setEmbedder and setVectorSearch", () => {
    const db = openDatabase(":memory:");
    const engine = new SqliteSearchEngine(new SqliteDocumentStore(db));
    expect(typeof (engine as any).setEmbedder).toBe("function");
    expect(typeof (engine as any).setVectorSearch).toBe("function");
    // VectorSearch satisfies the IVectorSearch interface the engine field now uses:
    expect(() => engine.setVectorSearch(new VectorSearch(db))).not.toThrow();
    db.close();
  });
});
