import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import type { KnowledgeEntry } from "../../src/knowledge/knowledge-store.js";

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: `k_${Math.random().toString(36).slice(2, 10)}`,
    type: "decision",
    project: "p",
    sessionId: "sess_a",
    timestamp: Date.now(),
    summary: "use Postgres",
    details: "decided to switch from SQLite to Postgres for multi-tenant",
    tags: [],
    relatedFiles: [],
    ...overrides,
  };
}

describe("SearchResult provenance field", () => {
  let store: SqliteKnowledgeStore;
  let engine: SqliteSearchEngine;
  let entry: KnowledgeEntry;

  beforeEach(async () => {
    const db = openDatabase(":memory:");
    const docStore = new SqliteDocumentStore(db);
    store = new SqliteKnowledgeStore(db);
    engine = new SqliteSearchEngine(docStore, null, null, null, store);

    entry = makeEntry();
    await store.addEntry(entry);
  });

  it("populates ProvenanceHandle on knowledge SearchResult", async () => {
    // Search via the knowledge store path
    const results = await store.search("Postgres");
    // The knowledgeEntryToSearchResult mapper should populate provenance
    // We verify via the exported helper directly since SearchResult.provenance
    // is populated by the mapper.

    // Import the mapper and check it
    const { knowledgeEntryToSearchResult } = await import(
      "../../src/search/knowledge-to-search-result.js"
    );
    const result = knowledgeEntryToSearchResult(entry);
    expect(result.provenance).toBeDefined();
    expect(result.provenance!.id).toBe(entry.id);
    expect(result.provenance!.sessionId).toBe("sess_a");
    expect(result.provenance!.editCount).toBe(0);
    // source discriminator lives on SearchResult.source, not on provenance
  });

  it("getEditCount returns 0 for unedited entry, 2 after two updates", async () => {
    expect(await store.getEditCount(entry.id)).toBe(0);
    await store.updateEntry(entry.id, { summary: "use Postgres v2" });
    await store.updateEntry(entry.id, { summary: "use Postgres v3" });
    expect(await store.getEditCount(entry.id)).toBe(2);
  });
});
