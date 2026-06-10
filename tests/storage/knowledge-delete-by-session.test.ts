import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import type { KnowledgeEntry } from "../../src/knowledge/knowledge-store.js";

function entry(id: string, sessionId: string, user: string): KnowledgeEntry {
  return { id, type: "fact", project: "p", sessionId, timestamp: Date.now(),
    summary: `sum ${id}`, details: `det ${id}`, tags: [], relatedFiles: [], importance: 0.5, user } as KnowledgeEntry;
}

describe("SqliteKnowledgeStore.deleteBySessionId", () => {
  let db: ReturnType<typeof openDatabase>;
  let store: SqliteKnowledgeStore;
  beforeEach(() => { db = openDatabase(":memory:"); store = new SqliteKnowledgeStore(db); });

  it("deletes all entries for a session and keeps FTS consistent", async () => {
    await store.addEntry(entry("e1", "sess-A", "u1"));
    await store.addEntry(entry("e2", "sess-A", "u1"));
    await store.addEntry(entry("e3", "sess-B", "u1"));
    const removed = await store.deleteBySessionId("sess-A", "u1");
    expect(removed).toBe(2);
    expect(await store.getEntry("e1")).toBeUndefined();
    expect(await store.getEntry("e3")).toBeDefined();
    // FTS consistency: a search that matched e1 must no longer return it.
    const hits = await store.search("sum e1", "p", "u1");
    expect(hits.find((h) => h.id === "e1")).toBeUndefined();
  });
});
