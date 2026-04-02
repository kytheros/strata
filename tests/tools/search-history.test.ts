import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import { handleSearchHistory } from "../../src/tools/search-history.js";
import type { KnowledgeEntry } from "../../src/knowledge/knowledge-store.js";
import type { DocumentMetadata } from "../../src/indexing/document-store.js";

function makeMetadata(overrides: Partial<DocumentMetadata> = {}): DocumentMetadata {
  return {
    sessionId: "session-1",
    project: "test-project",
    role: "mixed",
    timestamp: Date.now(),
    toolNames: [],
    messageIndex: 0,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2, 8)}`,
    type: "episodic",
    project: "test-project",
    sessionId: "session-1",
    timestamp: Date.now(),
    summary: "User attended an LGBTQ support group",
    details: "The user mentioned attending an LGBTQ support group meeting last Tuesday",
    tags: ["personal", "social"],
    relatedFiles: [],
    importance: 5.0,
    ...overrides,
  };
}

describe("handleSearchHistory knowledge retrieval", () => {
  let db: Database.Database;
  let docStore: SqliteDocumentStore;
  let knowledgeStore: SqliteKnowledgeStore;
  let engine: SqliteSearchEngine;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    docStore = new SqliteDocumentStore(db);
    knowledgeStore = new SqliteKnowledgeStore(db);
    engine = new SqliteSearchEngine(docStore, null, null, null, knowledgeStore);

    // Add a knowledge entry (as would happen after ingest_conversation)
    await knowledgeStore.addEntry(makeEntry());
  });

  afterEach(() => {
    db.close();
  });

  it("finds knowledge entries even when documents_fts has no matches", async () => {
    // No documents stored — only knowledge entries exist
    // search_history should still find the knowledge entry
    const result = await handleSearchHistory(
      engine,
      { query: "LGBTQ support group" },
      db,
      undefined,
      knowledgeStore
    );

    expect(result).not.toContain("No results found");
    expect(result).toContain("support group");
  });

  it("finds knowledge entries when query contains question words that fail LIKE", async () => {
    // LOCOMO-style question: "What did the user attend?"
    // The LIKE-based searchKnowledge requires ALL terms to appear as substrings.
    // "what" and "did" don't appear in the knowledge entry, so LIKE fails.
    // FTS5 with stop-word removal should find the entry via "attend".
    const result = await handleSearchHistory(
      engine,
      { query: "What group did they attend?" },
      db,
      undefined,
      knowledgeStore
    );

    // The knowledge entry has: "User attended an LGBTQ support group"
    // FTS5 should match "attend" -> "attended", "group" -> "group"
    expect(result).not.toContain("No results found");
    expect(result).toContain("support group");
  });

  it("finds knowledge entries via FTS5 for natural language questions", async () => {
    // Store a knowledge entry with a rephrased summary
    await knowledgeStore.addEntry(makeEntry({
      id: "entry-rephrase",
      summary: "Caroline researched international adoption agencies",
      details: "Caroline mentioned looking into agencies that handle international adoptions for same-sex couples",
      sessionId: "session-2",
    }));

    // LOCOMO-style question that includes function words that break LIKE
    const result = await handleSearchHistory(
      engine,
      { query: "What did Caroline research?" },
      db,
      undefined,
      knowledgeStore
    );

    expect(result).not.toContain("No results found");
    expect(result).toContain("Caroline");
  });

  it("merges knowledge results with document results", async () => {
    // Add a document that matches a different query aspect
    await docStore.add(
      "We discussed the project configuration for deployment",
      10,
      makeMetadata({ sessionId: "session-doc", project: "test-project" })
    );

    // Add a knowledge entry about a completely different topic
    await knowledgeStore.addEntry(makeEntry({
      id: "entry-different",
      summary: "User prefers dark mode in all applications",
      details: "User explicitly stated preference for dark mode UI",
      sessionId: "session-3",
    }));

    // Search for "What is the user's preferred UI theme?" — a natural language
    // question where the knowledge entry won't match LIKE (too many function words)
    // but FTS5 should match "preferred" and "UI"
    const result = await handleSearchHistory(
      engine,
      { query: "What is the user's preferred UI theme?" },
      db,
      undefined,
      knowledgeStore
    );

    expect(result).not.toContain("No results found");
    expect(result).toContain("dark mode");
  });
});
