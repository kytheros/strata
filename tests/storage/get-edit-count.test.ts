import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import type { KnowledgeEntry } from "../../src/knowledge/knowledge-store.js";

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: `k_${Math.random().toString(36).slice(2, 10)}`,
    type: "decision",
    project: "p",
    sessionId: "sess1",
    timestamp: Date.now(),
    summary: "s",
    details: "d",
    tags: [],
    relatedFiles: [],
    ...overrides,
  };
}

describe("SqliteKnowledgeStore.getEditCount", () => {
  let store: SqliteKnowledgeStore;

  beforeEach(() => {
    const db = openDatabase(":memory:");
    store = new SqliteKnowledgeStore(db);
  });

  it("returns 0 for an entry with no edits", async () => {
    const entry = makeEntry();
    await store.addEntry(entry);
    expect(await store.getEditCount(entry.id)).toBe(0);
  });

  it("returns 2 for an entry edited twice", async () => {
    const entry = makeEntry();
    await store.addEntry(entry);
    await store.updateEntry(entry.id, { summary: "s2" });
    await store.updateEntry(entry.id, { summary: "s3" });
    expect(await store.getEditCount(entry.id)).toBe(2);
  });
});
