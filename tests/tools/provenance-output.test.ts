/**
 * Tests that search tool responses include bracket-handle provenance citations.
 *
 * Note: handleSearchHistory and handleFindSolutions are the primary targets.
 * semantic_search is implemented inline in server.ts; its provenance is tested
 * via the shared knowledgeEntryToSearchResult path (see tests/search/provenance.test.ts).
 *
 * get_project_context reads from jsonl history files; the Sources: block is
 * added by a new IKnowledgeStore-aware overload tested here.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import { handleSearchHistory } from "../../src/tools/search-history.js";
import { handleFindSolutions } from "../../src/tools/find-solutions.js";
import { buildProvenanceSources } from "../../src/tools/get-project-context.js";
import type { KnowledgeEntry } from "../../src/knowledge/knowledge-store.js";

// Bracket-handle pattern: [mem:<prefix>_<6 alphanum chars> (optional: sess:...) t:YYYY-MM-DD]
const BRACKET_RE = /\[mem:[a-z]_[a-z0-9]{6}( sess:[a-z]_[a-z0-9]{6})? t:\d{4}-\d{2}-\d{2}\]/;

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  // Use UUID-style hex IDs to match production store_memory output
  const hex = () => Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  return {
    id: `k_${hex()}-${hex()}-${hex()}-${hex()}`,
    type: "decision",
    project: "p",
    sessionId: `s_${hex()}-${hex()}-${hex()}-${hex()}`,
    timestamp: Date.now(),
    summary: "use Postgres",
    details: "decided to use Postgres for multi-tenant support",
    tags: [],
    relatedFiles: [],
    ...overrides,
  };
}

describe("provenance bracket-handle on search tools", () => {
  let db: Database.Database;
  let docStore: SqliteDocumentStore;
  let knowledgeStore: SqliteKnowledgeStore;
  let engine: SqliteSearchEngine;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    docStore = new SqliteDocumentStore(db);
    knowledgeStore = new SqliteKnowledgeStore(db);
    engine = new SqliteSearchEngine(docStore, null, null, null, knowledgeStore);

    await knowledgeStore.addEntry(makeEntry());
  });

  afterEach(() => {
    db.close();
  });

  it("search_history result header includes the bracket handle", async () => {
    const out = await handleSearchHistory(
      engine,
      { query: "Postgres" },
      db,
      undefined,
      knowledgeStore
    );
    expect(out).toMatch(BRACKET_RE);
  });

  it("find_solutions result header includes the bracket handle", async () => {
    const out = await handleFindSolutions(
      engine,
      { error_or_problem: "Postgres" },
      db,
      undefined,
      knowledgeStore
    );
    expect(out).toMatch(BRACKET_RE);
  });
});

describe("buildProvenanceSources helper", () => {
  it("returns empty string for empty entries", () => {
    expect(buildProvenanceSources([])).toBe("");
  });

  it("returns Sources: block with bracket-handles for entries", () => {
    const entries: KnowledgeEntry[] = [
      {
        id: "k_ab1234cd-0000-4000-a000-000000000000",
        sessionId: "s_ef567800-0000-4000-a000-000000000000",
        timestamp: 1715126400000,
        type: "decision",
        project: "p",
        summary: "use Postgres",
        details: "",
        tags: [],
        relatedFiles: [],
      },
    ];
    const out = buildProvenanceSources(entries);
    expect(out).toMatch(/^\nSources: \[mem:k_[0-9a-f]{6}/);
    expect(out).toMatch(/t:2024-05-08/);
  });

  it("deduplicates entries by id", () => {
    const entry: KnowledgeEntry = {
      id: "k_ab1234cd-0000-4000-a000-000000000000",
      sessionId: null,
      timestamp: 1715126400000,
      type: "decision",
      project: "p",
      summary: "s",
      details: "",
      tags: [],
      relatedFiles: [],
    };
    const out = buildProvenanceSources([entry, entry]);
    // Should only appear once
    const matches = out.match(/\[mem:/g);
    expect(matches?.length).toBe(1);
  });
});
