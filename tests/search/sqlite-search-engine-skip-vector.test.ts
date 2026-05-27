import { describe, it, expect, vi } from "vitest";
import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";

describe("SqliteSearchEngine.searchAsync — skipVector option", () => {
  it("does not call embedder.embed when skipVector=true", async () => {
    const docStore = {
      search: vi.fn().mockResolvedValue([]),
    } as any;
    const embedder = {
      embed: vi.fn().mockResolvedValue(new Float32Array(3072)),
    } as any;
    const vectorSearch = {
      search: vi.fn().mockReturnValue([]),
      searchAll: vi.fn().mockReturnValue([]),
      searchDocumentChunks: vi.fn().mockReturnValue([]),
    } as any;

    const engine = new SqliteSearchEngine(docStore, embedder, vectorSearch);

    await engine.searchAsync("hello world", { limit: 10, skipVector: true });

    expect(embedder.embed).not.toHaveBeenCalled();
    expect(vectorSearch.search).not.toHaveBeenCalled();
  });

  it("DOES call embedder.embed when skipVector is omitted (back-compat)", async () => {
    const docStore = {
      search: vi.fn().mockResolvedValue([]),
    } as any;
    const embedder = {
      embed: vi.fn().mockResolvedValue(new Float32Array(3072)),
    } as any;
    const vectorSearch = {
      search: vi.fn().mockReturnValue([]),
      searchAll: vi.fn().mockReturnValue([]),
      searchDocumentChunks: vi.fn().mockReturnValue([]),
    } as any;

    const engine = new SqliteSearchEngine(docStore, embedder, vectorSearch);

    await engine.searchAsync("hello world", { limit: 10 });

    expect(embedder.embed).toHaveBeenCalledOnce();
  });
});
