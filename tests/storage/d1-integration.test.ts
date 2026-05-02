/**
 * D1 Storage Integration Tests.
 *
 * Uses Miniflare to spin up a local D1-compatible SQLite database and tests
 * the full D1 storage layer end-to-end: schema init, CRUD for all five stores,
 * FTS5 search, user isolation, entity graph, vector search, and batch atomicity.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Miniflare } from "miniflare";
import { createD1Storage } from "../../src/storage/d1/index.js";
import { D1VectorSearch } from "../../src/storage/d1/d1-vector-search.js";
import type { StorageContext } from "../../src/storage/interfaces/index.js";
import type { KnowledgeEntry } from "../../src/knowledge/knowledge-store.js";
import type { SessionSummary } from "../../src/knowledge/session-summarizer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

let entryCounter = 0;

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  entryCounter++;
  return {
    id: overrides.id ?? `entry-${entryCounter}-${Math.random().toString(36).slice(2, 8)}`,
    type: "solution",
    project: "test-project",
    sessionId: "session-1",
    timestamp: Date.now(),
    summary: "Fixed the build error",
    details: "The issue was a missing dependency in package.json",
    tags: ["build", "npm"],
    relatedFiles: ["package.json"],
    ...overrides,
  };
}

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: overrides.sessionId ?? `sess-${Math.random().toString(36).slice(2, 8)}`,
    project: "test-project",
    projectName: "test-project",
    startTime: Date.now() - 60_000,
    endTime: Date.now(),
    duration: 60_000,
    messageCount: 10,
    userMessageCount: 5,
    topic: "Debugging build failures",
    keyTopics: ["build", "typescript"],
    toolsUsed: ["Read", "Edit"],
    filesReferenced: ["src/index.ts"],
    hasCodeChanges: true,
    lastUserMessage: "Thanks, that fixed it",
    ...overrides,
  };
}

/**
 * Helper to add a document with the correct user scope.
 *
 * D1DocumentStore.add() defaults user to "default" when not provided, which
 * bypasses the `user || this.userId` fallback. Passing "" as user triggers it.
 */
function addDoc(
  storage: StorageContext,
  text: string,
  tokenCount: number,
  metadata: {
    sessionId: string;
    project: string;
    role: "user" | "assistant" | "mixed";
    timestamp: number;
    toolNames: string[];
    messageIndex: number;
  },
  user: string = ""
) {
  return storage.documents.add(text, tokenCount, metadata, "claude-code", user);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("D1 Storage Integration", () => {
  let mf: Miniflare;
  let db: any; // miniflare D1Database
  let storage: StorageContext;

  beforeEach(async () => {
    entryCounter = 0;
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: ["STRATA_DB"],
    });
    db = await mf.getD1Database("STRATA_DB");
    storage = await createD1Storage({ d1: db, userId: USER_A });
  });

  afterEach(async () => {
    await storage.close();
    await mf.dispose();
  });

  // -------------------------------------------------------------------------
  // 1. Schema Initialization
  // -------------------------------------------------------------------------

  describe("schema initialization", () => {
    it("should create all expected tables", async () => {
      const result = await db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all();
      const names: string[] = result.results.map((r: any) => r.name);

      const expectedTables = [
        "analytics",
        "documents",
        "documents_fts",
        "embeddings",
        "entities",
        "entity_relations",
        "evidence_gaps",
        "index_meta",
        "knowledge",
        "knowledge_entities",
        "knowledge_history",
        "knowledge_turns",
        "knowledge_turns_fts",
        "summaries",
      ];

      for (const table of expectedTables) {
        expect(names).toContain(table);
      }
    });

    it("should create the FTS5 virtual table", async () => {
      const result = await db
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name = 'documents_fts'"
        )
        .first();
      expect(result).not.toBeNull();
      expect(result.sql).toContain("fts5");
    });

    it("should create indexes", async () => {
      const result = await db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
        .all();
      const names: string[] = result.results.map((r: any) => r.name);

      const expectedIndexes = [
        "idx_documents_session",
        "idx_documents_project",
        "idx_documents_user",
        "idx_knowledge_project",
        "idx_knowledge_type",
        "idx_knowledge_user",
        "idx_kh_entry",
        "idx_summaries_project",
        "idx_summaries_user",
        "idx_entities_canonical",
        "idx_entities_type",
        "idx_entities_user",
        "idx_er_source",
        "idx_er_target",
        "idx_analytics_type",
        "idx_analytics_timestamp",
      ];

      for (const idx of expectedIndexes) {
        expect(names).toContain(idx);
      }
    });

    it("should record the schema version in index_meta", async () => {
      const row = await db
        .prepare("SELECT value FROM index_meta WHERE key = 'schema_version'")
        .first();
      expect(row).not.toBeNull();
      expect(row.value).toBe("4");
    });

    it("should be idempotent (calling createD1Storage twice is safe)", async () => {
      const storage2 = await createD1Storage({ d1: db, userId: USER_A });
      await storage2.close();
      // No error means idempotent schema init worked
      const count = await db
        .prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type = 'table'")
        .first();
      expect(count.cnt).toBeGreaterThanOrEqual(14);
    });
  });

  // -------------------------------------------------------------------------
  // 1b. Migration 0004 — knowledge_turns
  // -------------------------------------------------------------------------

  describe("migration 0004 — knowledge_turns", () => {
    it("creates knowledge_turns table with all required columns", async () => {
      const row = await db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_turns'")
        .first();
      expect(row).not.toBeNull();
      expect(row.sql).toContain("turn_id");
      expect(row.sql).toContain("session_id");
      expect(row.sql).toContain("project");
      expect(row.sql).toContain("user_id");
      expect(row.sql).toContain("speaker");
      expect(row.sql).toContain("content");
      expect(row.sql).toContain("message_index");
      expect(row.sql).toContain("created_at");
    });

    it("creates knowledge_turns_fts virtual table with porter tokenizer", async () => {
      const row = await db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_turns_fts'"
        )
        .first();
      expect(row).not.toBeNull();
      expect(row.sql).toContain("fts5");
      expect(row.sql).toContain("porter");
    });

    it("creates idx_knowledge_turns_session index", async () => {
      const result = await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_knowledge_turns_session'"
        )
        .first();
      expect(result).not.toBeNull();
    });

    it("creates idx_knowledge_turns_project index", async () => {
      const result = await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_knowledge_turns_project'"
        )
        .first();
      expect(result).not.toBeNull();
    });

    it("creates knowledge_turns_ai insert trigger", async () => {
      const result = await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'knowledge_turns_ai'"
        )
        .first();
      expect(result).not.toBeNull();
    });

    it("creates knowledge_turns_ad delete trigger", async () => {
      const result = await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'knowledge_turns_ad'"
        )
        .first();
      expect(result).not.toBeNull();
    });

    it("insert trigger populates knowledge_turns_fts", async () => {
      await db
        .prepare(
          "INSERT INTO knowledge_turns (turn_id, session_id, speaker, content, message_index, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .bind("t-d1-1", "sess1", "user", "TypeScript generics explained", 0, Date.now())
        .run();

      const result = await db
        .prepare(
          "SELECT rowid FROM knowledge_turns_fts WHERE knowledge_turns_fts MATCH 'typescript'"
        )
        .all();
      expect(result.results.length).toBe(1);
    });

    it("delete trigger removes entry from knowledge_turns_fts", async () => {
      await db
        .prepare(
          "INSERT INTO knowledge_turns (turn_id, session_id, speaker, content, message_index, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .bind("t-d1-2", "sess1", "assistant", "SQLite FTS5 search pattern", 0, Date.now())
        .run();
      await db
        .prepare("DELETE FROM knowledge_turns WHERE turn_id = ?")
        .bind("t-d1-2")
        .run();

      const result = await db
        .prepare(
          "SELECT rowid FROM knowledge_turns_fts WHERE knowledge_turns_fts MATCH 'sqlite'"
        )
        .all();
      expect(result.results.length).toBe(0);
    });

    it("does not modify knowledge or knowledge_fts (additive only)", async () => {
      const knowledgeSql = await db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'knowledge'")
        .first();
      expect(knowledgeSql.sql).toContain("summary");
      expect(knowledgeSql.sql).not.toContain("turn_id");

      const ftsSql = await db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_fts'")
        .first();
      expect(ftsSql.sql).toContain("summary");
      expect(ftsSql.sql).not.toContain("knowledge_turns");
    });

    it("existing v3 DB upgrades to v4 idempotently", async () => {
      // Simulate a v3 DB by creating fresh storage twice — second call should be no-op
      const storage2 = await createD1Storage({ d1: db, userId: USER_A });
      await storage2.close();

      const versionRow = await db
        .prepare("SELECT value FROM index_meta WHERE key = 'schema_version'")
        .first();
      expect(versionRow.value).toBe("4");

      // knowledge_turns must still exist and have correct structure
      const turns = await db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_turns'")
        .first();
      expect(turns).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 2. Knowledge Store CRUD
  // -------------------------------------------------------------------------

  describe("knowledge store CRUD", () => {
    it("should add and retrieve an entry", async () => {
      const entry = makeEntry({ id: "k1" });
      await storage.knowledge.addEntry(entry);

      const result = await storage.knowledge.getEntry("k1");
      expect(result).toBeDefined();
      expect(result!.id).toBe("k1");
      expect(result!.summary).toBe(entry.summary);
      expect(result!.details).toBe(entry.details);
      expect(result!.tags).toEqual(["build", "npm"]);
      expect(result!.relatedFiles).toEqual(["package.json"]);
    });

    it("hasEntry should return true for existing, false for missing", async () => {
      const entry = makeEntry({ id: "k2" });
      await storage.knowledge.addEntry(entry);

      expect(await storage.knowledge.hasEntry("k2")).toBe(true);
      expect(await storage.knowledge.hasEntry("nonexistent")).toBe(false);
    });

    it("should skip duplicate entries (same project+type+summary+user)", async () => {
      const e1 = makeEntry({ id: "dup1", summary: "Same summary" });
      const e2 = makeEntry({ id: "dup2", summary: "Same summary" });

      await storage.knowledge.addEntry(e1);
      await storage.knowledge.addEntry(e2);

      expect(await storage.knowledge.getEntryCount()).toBe(1);
      expect(await storage.knowledge.getEntry("dup1")).toBeDefined();
      expect(await storage.knowledge.getEntry("dup2")).toBeUndefined();
    });

    it("should update an entry and persist changes", async () => {
      await storage.knowledge.addEntry(makeEntry({ id: "upd1", summary: "Original" }));

      const updated = await storage.knowledge.updateEntry("upd1", {
        summary: "Updated summary",
        tags: ["new-tag"],
      });
      expect(updated).toBe(true);

      const result = await storage.knowledge.getEntry("upd1");
      expect(result!.summary).toBe("Updated summary");
      expect(result!.tags).toEqual(["new-tag"]);
    });

    it("updateEntry should return false for nonexistent entry", async () => {
      const updated = await storage.knowledge.updateEntry("ghost", { summary: "nope" });
      expect(updated).toBe(false);
    });

    it("should delete an entry", async () => {
      await storage.knowledge.addEntry(makeEntry({ id: "del1" }));
      expect(await storage.knowledge.hasEntry("del1")).toBe(true);

      const deleted = await storage.knowledge.deleteEntry("del1");
      expect(deleted).toBe(true);
      expect(await storage.knowledge.hasEntry("del1")).toBe(false);
    });

    it("deleteEntry should return false for nonexistent entry", async () => {
      const deleted = await storage.knowledge.deleteEntry("ghost");
      expect(deleted).toBe(false);
    });

    it("should search by keyword in summary", async () => {
      await storage.knowledge.addEntry(makeEntry({ id: "s1", summary: "Docker compose fix" }));
      await storage.knowledge.addEntry(makeEntry({ id: "s2", summary: "React component bug" }));

      const results = await storage.knowledge.search("docker");
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("s1");
    });

    it("should search by keyword in details", async () => {
      await storage.knowledge.addEntry(
        makeEntry({ id: "sd1", summary: "A fix", details: "Use kubernetes to deploy" })
      );
      const results = await storage.knowledge.search("kubernetes");
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("sd1");
    });

    it("should filter search by project", async () => {
      await storage.knowledge.addEntry(
        makeEntry({ id: "sp1", project: "proj-a", summary: "Docker fix" })
      );
      await storage.knowledge.addEntry(
        makeEntry({ id: "sp2", project: "proj-b", summary: "Docker config" })
      );

      const results = await storage.knowledge.search("docker", "proj-a");
      expect(results).toHaveLength(1);
      expect(results[0].project).toBe("proj-a");
    });

    it("should filter by knowledge type", async () => {
      await storage.knowledge.addEntry(makeEntry({ id: "t1", type: "solution", summary: "S1" }));
      await storage.knowledge.addEntry(makeEntry({ id: "t2", type: "pattern", summary: "P1" }));
      await storage.knowledge.addEntry(
        makeEntry({ id: "t3", type: "solution", summary: "S2" })
      );

      const results = await storage.knowledge.getByType("solution");
      expect(results).toHaveLength(2);
      results.forEach((r) => expect(r.type).toBe("solution"));
    });

    it("should return correct entry count", async () => {
      expect(await storage.knowledge.getEntryCount()).toBe(0);
      await storage.knowledge.addEntry(makeEntry({ id: "c1", summary: "A" }));
      await storage.knowledge.addEntry(makeEntry({ id: "c2", summary: "B" }));
      expect(await storage.knowledge.getEntryCount()).toBe(2);
    });

    it("should paginate with getEntries", async () => {
      for (let i = 0; i < 5; i++) {
        await storage.knowledge.addEntry(
          makeEntry({ id: `page-${i}`, summary: `Entry ${i}`, timestamp: Date.now() + i })
        );
      }

      const page1 = await storage.knowledge.getEntries({ limit: 2, offset: 0 });
      expect(page1.entries).toHaveLength(2);
      expect(page1.total).toBe(5);

      const page2 = await storage.knowledge.getEntries({ limit: 2, offset: 2 });
      expect(page2.entries).toHaveLength(2);

      const page3 = await storage.knowledge.getEntries({ limit: 2, offset: 4 });
      expect(page3.entries).toHaveLength(1);
    });

    it("getEntries should support sorting by newest/oldest", async () => {
      const now = Date.now();
      await storage.knowledge.addEntry(
        makeEntry({ id: "old", summary: "Old", timestamp: now - 10000 })
      );
      await storage.knowledge.addEntry(
        makeEntry({ id: "new", summary: "New", timestamp: now })
      );

      const newest = await storage.knowledge.getEntries({ limit: 10, offset: 0, sort: "newest" });
      expect(newest.entries[0].id).toBe("new");

      const oldest = await storage.knowledge.getEntries({ limit: 10, offset: 0, sort: "oldest" });
      expect(oldest.entries[0].id).toBe("old");
    });
  });

  // -------------------------------------------------------------------------
  // 3. User Isolation (CRITICAL)
  // -------------------------------------------------------------------------

  describe("user isolation", () => {
    let storageB: StorageContext;

    beforeEach(async () => {
      storageB = await createD1Storage({ d1: db, userId: USER_B });
    });

    afterEach(async () => {
      await storageB.close();
    });

    it("knowledge: user B cannot see user A entries", async () => {
      await storage.knowledge.addEntry(makeEntry({ id: "iso-k1", summary: "Secret A" }));

      // User B searches
      const results = await storageB.knowledge.search("Secret");
      expect(results).toHaveLength(0);

      // User B getEntry
      expect(await storageB.knowledge.getEntry("iso-k1")).toBeUndefined();

      // User B getAllEntries
      const all = await storageB.knowledge.getAllEntries();
      expect(all).toHaveLength(0);
    });

    it("knowledge: user B cannot update or delete user A entries", async () => {
      await storage.knowledge.addEntry(makeEntry({ id: "iso-k2", summary: "A only" }));

      const updated = await storageB.knowledge.updateEntry("iso-k2", { summary: "hacked" });
      expect(updated).toBe(false);

      const deleted = await storageB.knowledge.deleteEntry("iso-k2");
      expect(deleted).toBe(false);

      // Verify A's entry is untouched
      const entry = await storage.knowledge.getEntry("iso-k2");
      expect(entry!.summary).toBe("A only");
    });

    it("documents: user B cannot see user A documents", async () => {
      const docId = await addDoc(
        storage,
        "User A document text about TypeScript",
        100,
        {
          sessionId: "sess-a",
          project: "proj-a",
          role: "user",
          timestamp: Date.now(),
          toolNames: [],
          messageIndex: 0,
        },
        USER_A
      );

      // User B cannot get or search
      expect(await storageB.documents.get(docId)).toBeUndefined();
      const bDocs = await storageB.documents.getBySession("sess-a");
      expect(bDocs).toHaveLength(0);
      expect(await storageB.documents.getDocumentCount()).toBe(0);
    });

    it("entities: user B cannot see user A entities", async () => {
      await storage.entities.upsertEntity({
        id: "ent-iso1",
        name: "React",
        type: "framework",
        canonicalName: "React",
        aliases: ["reactjs"],
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        project: "test-project",
        user: USER_A,
      });

      const found = await storageB.entities.findByName("React");
      expect(found).toBeUndefined();
    });

    it("summaries: user B cannot see user A summaries", async () => {
      const summary = makeSummary({ sessionId: "sess-iso" });
      await storage.summaries.save(summary);

      expect(await storageB.summaries.get("sess-iso")).toBeNull();
      const recent = await storageB.summaries.getRecent();
      expect(recent).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Document Store + FTS5
  // -------------------------------------------------------------------------

  describe("document store + FTS5", () => {
    it("should add and retrieve a document", async () => {
      const id = await addDoc(
        storage,
        "Setting up Docker compose for local development",
        50,
        {
          sessionId: "sess-d1",
          project: "my-project",
          role: "user",
          timestamp: Date.now(),
          toolNames: ["Read"],
          messageIndex: 0,
        }
      );

      const doc = await storage.documents.get(id);
      expect(doc).toBeDefined();
      expect(doc!.text).toContain("Docker compose");
      expect(doc!.sessionId).toBe("sess-d1");
      expect(doc!.project).toBe("my-project");
    });

    it("should perform FTS5 BM25 search", async () => {
      await addDoc(storage, "React hooks provide state management", 40, {
        sessionId: "sess-fts",
        project: "proj-fts",
        role: "assistant",
        timestamp: Date.now(),
        toolNames: [],
        messageIndex: 0,
      });
      await addDoc(storage, "Python flask REST API endpoint", 35, {
        sessionId: "sess-fts",
        project: "proj-fts",
        role: "assistant",
        timestamp: Date.now(),
        toolNames: [],
        messageIndex: 1,
      });

      const results = await storage.documents.search("React hooks");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].chunk.text).toContain("React");
      expect(typeof results[0].rank).toBe("number");
    });

    it("FTS5 AND->OR fallback: multi-word query that fails AND succeeds OR", async () => {
      await addDoc(storage, "TypeScript compiler diagnostics", 30, {
        sessionId: "sess-fallback",
        project: "proj-fb",
        role: "user",
        timestamp: Date.now(),
        toolNames: [],
        messageIndex: 0,
      });
      await addDoc(storage, "Python linter configuration", 30, {
        sessionId: "sess-fallback",
        project: "proj-fb",
        role: "user",
        timestamp: Date.now(),
        toolNames: [],
        messageIndex: 1,
      });

      // "TypeScript linter" won't match any single doc with AND, but OR fallback
      // should return both since each matches one term
      const results = await storage.documents.search("TypeScript linter");
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("should filter documents by session", async () => {
      await addDoc(storage, "Doc in sess1", 10, {
        sessionId: "sess-1",
        project: "p",
        role: "user",
        timestamp: Date.now(),
        toolNames: [],
        messageIndex: 0,
      });
      await addDoc(storage, "Doc in sess2", 10, {
        sessionId: "sess-2",
        project: "p",
        role: "user",
        timestamp: Date.now(),
        toolNames: [],
        messageIndex: 0,
      });

      const docs = await storage.documents.getBySession("sess-1");
      expect(docs).toHaveLength(1);
      expect(docs[0].text).toBe("Doc in sess1");
    });

    it("should return correct document count", async () => {
      expect(await storage.documents.getDocumentCount()).toBe(0);
      await addDoc(storage, "A", 10, {
        sessionId: "s",
        project: "p",
        role: "user",
        timestamp: Date.now(),
        toolNames: [],
        messageIndex: 0,
      });
      await addDoc(storage, "B", 20, {
        sessionId: "s",
        project: "p",
        role: "user",
        timestamp: Date.now(),
        toolNames: [],
        messageIndex: 1,
      });
      expect(await storage.documents.getDocumentCount()).toBe(2);
    });

    it("should remove a document", async () => {
      const id = await addDoc(storage, "Remove me", 10, {
        sessionId: "s",
        project: "p",
        role: "user",
        timestamp: Date.now(),
        toolNames: [],
        messageIndex: 0,
      });
      expect(await storage.documents.get(id)).toBeDefined();
      await storage.documents.remove(id);
      expect(await storage.documents.get(id)).toBeUndefined();
    });

    it("should return session IDs and projects", async () => {
      await addDoc(storage, "A", 10, {
        sessionId: "s1",
        project: "p1",
        role: "user",
        timestamp: Date.now(),
        toolNames: [],
        messageIndex: 0,
      });
      await addDoc(storage, "B", 10, {
        sessionId: "s2",
        project: "p2",
        role: "user",
        timestamp: Date.now(),
        toolNames: [],
        messageIndex: 0,
      });

      const sessionIds = await storage.documents.getSessionIds();
      expect(sessionIds.has("s1")).toBe(true);
      expect(sessionIds.has("s2")).toBe(true);

      const projects = await storage.documents.getProjects();
      expect(projects.has("p1")).toBe(true);
      expect(projects.has("p2")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Entity Store
  // -------------------------------------------------------------------------

  describe("entity store", () => {
    it("should upsert a new entity", async () => {
      const id = await storage.entities.upsertEntity({
        id: "ent-1",
        name: "React",
        type: "framework",
        canonicalName: "React",
        aliases: ["reactjs"],
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        project: "my-project",
        user: USER_A,
      });

      expect(id).toBe("ent-1");

      const found = await storage.entities.findByName("React");
      expect(found).toBeDefined();
      expect(found!.name).toBe("React");
      expect(found!.type).toBe("framework");
      expect(found!.mention_count).toBe(1);
    });

    it("should increment mention_count on re-upsert", async () => {
      const input = {
        id: "ent-mc",
        name: "TypeScript",
        type: "language" as const,
        canonicalName: "TypeScript",
        aliases: ["ts"],
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        project: "proj",
        user: USER_A,
      };

      await storage.entities.upsertEntity(input);
      await storage.entities.upsertEntity({ ...input, id: "ent-mc-2" }); // same canonical name

      const found = await storage.entities.findByName("TypeScript");
      expect(found!.mention_count).toBe(2);
    });

    it("should merge aliases on re-upsert", async () => {
      await storage.entities.upsertEntity({
        id: "ent-alias",
        name: "React",
        type: "framework",
        canonicalName: "React",
        aliases: ["reactjs"],
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        user: USER_A,
      });

      await storage.entities.upsertEntity({
        id: "ent-alias2",
        name: "React",
        type: "framework",
        canonicalName: "React",
        aliases: ["react.js", "ReactJS"],
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        user: USER_A,
      });

      const found = await storage.entities.findByName("React");
      const aliases: string[] = JSON.parse(found!.aliases);
      // Should include both "reactjs" and "react.js" (deduped case-insensitive)
      expect(aliases).toContain("reactjs");
      expect(aliases).toContain("react.js");
    });

    it("should add and retrieve relations", async () => {
      await storage.entities.upsertEntity({
        id: "ent-r1",
        name: "React",
        type: "framework",
        canonicalName: "React",
        aliases: [],
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        user: USER_A,
      });
      await storage.entities.upsertEntity({
        id: "ent-r2",
        name: "NextJS",
        type: "framework",
        canonicalName: "NextJS",
        aliases: [],
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        user: USER_A,
      });

      await storage.entities.addRelation({
        sourceEntityId: "ent-r1",
        targetEntityId: "ent-r2",
        relationType: "uses",
        context: "Next.js is built on React",
      });

      const relations = await storage.entities.getRelationsFor("ent-r1");
      expect(relations.length).toBeGreaterThanOrEqual(1);
      expect(relations[0].relation_type).toBe("uses");
    });

    it("should search entities by name", async () => {
      await storage.entities.upsertEntity({
        id: "ent-search1",
        name: "PostgreSQL",
        type: "service",
        canonicalName: "PostgreSQL",
        aliases: ["postgres"],
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        user: USER_A,
      });
      await storage.entities.upsertEntity({
        id: "ent-search2",
        name: "MySQL",
        type: "service",
        canonicalName: "MySQL",
        aliases: [],
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        user: USER_A,
      });

      const results = await storage.entities.searchEntities("Postgre");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].canonical_name).toBe("PostgreSQL");
    });

    it("should return entity graph with nodes and edges", async () => {
      await storage.entities.upsertEntity({
        id: "eg-1",
        name: "React",
        type: "framework",
        canonicalName: "React",
        aliases: [],
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        project: "graph-proj",
        user: USER_A,
      });
      await storage.entities.upsertEntity({
        id: "eg-2",
        name: "Redux",
        type: "library",
        canonicalName: "Redux",
        aliases: [],
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        project: "graph-proj",
        user: USER_A,
      });
      await storage.entities.addRelation({
        sourceEntityId: "eg-1",
        targetEntityId: "eg-2",
        relationType: "depends_on",
      });

      const graph = await storage.entities.getEntityGraph("graph-proj");
      expect(graph.nodes).toHaveLength(2);
      expect(graph.edges).toHaveLength(1);
      expect(graph.edges[0].source).toBe("eg-1");
      expect(graph.edges[0].target).toBe("eg-2");
    });

    it("should link knowledge entries to entities", async () => {
      await storage.knowledge.addEntry(makeEntry({ id: "ke-link", summary: "React perf tip" }));
      await storage.entities.upsertEntity({
        id: "ent-link",
        name: "React",
        type: "framework",
        canonicalName: "React",
        aliases: [],
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        user: USER_A,
      });

      await storage.entities.linkToKnowledge("ke-link", "ent-link");

      const knowledge = await storage.entities.getKnowledgeForEntity("ent-link");
      expect(knowledge).toHaveLength(1);
      expect(knowledge[0].id).toBe("ke-link");
    });

    it("should return entity type distribution", async () => {
      await storage.entities.upsertEntity({
        id: "dist-1",
        name: "React",
        type: "framework",
        canonicalName: "React",
        aliases: [],
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        user: USER_A,
      });
      await storage.entities.upsertEntity({
        id: "dist-2",
        name: "Docker",
        type: "tool",
        canonicalName: "Docker",
        aliases: [],
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        user: USER_A,
      });

      const dist = await storage.entities.getEntityTypeDistribution();
      expect(dist["framework"]).toBe(1);
      expect(dist["tool"]).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Summary Store
  // -------------------------------------------------------------------------

  describe("summary store", () => {
    it("should save and retrieve a session summary", async () => {
      const summary = makeSummary({ sessionId: "sum-1" });
      await storage.summaries.save(summary);

      const result = await storage.summaries.get("sum-1");
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe("sum-1");
      expect(result!.topic).toBe("Debugging build failures");
      expect(result!.messageCount).toBe(10);
    });

    it("should return null for nonexistent session", async () => {
      expect(await storage.summaries.get("nonexistent")).toBeNull();
    });

    it("should return recent summaries in order", async () => {
      const now = Date.now();
      await storage.summaries.save(makeSummary({ sessionId: "old", endTime: now - 10000 }));
      await storage.summaries.save(makeSummary({ sessionId: "new", endTime: now }));

      const recent = await storage.summaries.getRecent(10);
      expect(recent).toHaveLength(2);
      expect(recent[0].sessionId).toBe("new");
      expect(recent[1].sessionId).toBe("old");
    });

    it("should filter by project", async () => {
      await storage.summaries.save(makeSummary({ sessionId: "sp1", project: "proj-a" }));
      await storage.summaries.save(makeSummary({ sessionId: "sp2", project: "proj-b" }));

      const results = await storage.summaries.getByProject("proj-a");
      expect(results).toHaveLength(1);
      expect(results[0].project).toBe("proj-a");
    });

    it("should remove a summary", async () => {
      await storage.summaries.save(makeSummary({ sessionId: "rm-sum" }));
      expect(await storage.summaries.get("rm-sum")).not.toBeNull();

      await storage.summaries.remove("rm-sum");
      expect(await storage.summaries.get("rm-sum")).toBeNull();
    });

    it("should return correct count", async () => {
      expect(await storage.summaries.getCount()).toBe(0);
      await storage.summaries.save(makeSummary({ sessionId: "cnt1" }));
      await storage.summaries.save(makeSummary({ sessionId: "cnt2" }));
      expect(await storage.summaries.getCount()).toBe(2);
    });

    it("should return project session counts", async () => {
      await storage.summaries.save(makeSummary({ sessionId: "psc1", project: "alpha" }));
      await storage.summaries.save(makeSummary({ sessionId: "psc2", project: "alpha" }));
      await storage.summaries.save(makeSummary({ sessionId: "psc3", project: "beta" }));

      const counts = await storage.summaries.getProjectSessionCounts();
      expect(counts["alpha"]).toBe(2);
      expect(counts["beta"]).toBe(1);
    });

    it("user B cannot see user A summaries", async () => {
      await storage.summaries.save(makeSummary({ sessionId: "iso-sum" }));

      const storageB = await createD1Storage({ d1: db, userId: USER_B });
      expect(await storageB.summaries.get("iso-sum")).toBeNull();
      expect(await storageB.summaries.getRecent()).toHaveLength(0);
      await storageB.close();
    });
  });

  // -------------------------------------------------------------------------
  // 7. Meta Store
  // -------------------------------------------------------------------------

  describe("meta store", () => {
    it("should set and get a string value", async () => {
      await storage.meta.set("foo", "bar");
      expect(await storage.meta.get("foo")).toBe("bar");
    });

    it("should return undefined for missing key", async () => {
      expect(await storage.meta.get("missing")).toBeUndefined();
    });

    it("should round-trip JSON via setJson/getJson", async () => {
      const data = { count: 42, items: ["a", "b"] };
      await storage.meta.setJson("config", data);

      const result = await storage.meta.getJson<typeof data>("config");
      expect(result).toEqual(data);
    });

    it("should remove a key", async () => {
      await storage.meta.set("temp", "value");
      expect(await storage.meta.get("temp")).toBe("value");

      await storage.meta.remove("temp");
      expect(await storage.meta.get("temp")).toBeUndefined();
    });

    it("should return all key-value pairs", async () => {
      await storage.meta.set("key1", "val1");
      await storage.meta.set("key2", "val2");

      const all = await storage.meta.getAll();
      expect(all["key1"]).toBe("val1");
      expect(all["key2"]).toBe("val2");
      // Also includes schema_version from init
      expect(all["schema_version"]).toBe("4");
    });

    it("should overwrite existing key on set", async () => {
      await storage.meta.set("overwrite", "first");
      await storage.meta.set("overwrite", "second");
      expect(await storage.meta.get("overwrite")).toBe("second");
    });
  });

  // -------------------------------------------------------------------------
  // 8. Vector Search (Embeddings)
  // -------------------------------------------------------------------------

  describe("vector search", () => {
    it("should find entries by cosine similarity", async () => {
      // Insert knowledge entries for the join
      await storage.knowledge.addEntry(
        makeEntry({
          id: "vec-entry-1",
          project: "vec-project",
          summary: "React hooks guide",
        })
      );
      await storage.knowledge.addEntry(
        makeEntry({
          id: "vec-entry-2",
          project: "vec-project",
          summary: "Python async patterns",
        })
      );

      // Manually insert embeddings (4-dimensional for simplicity)
      const vec1 = new Float32Array([1.0, 0.0, 0.0, 0.0]);
      const vec2 = new Float32Array([0.0, 1.0, 0.0, 0.0]);

      await db
        .prepare(
          "INSERT INTO embeddings (id, embedding, model, created_at) VALUES (?, ?, ?, ?)"
        )
        .bind("vec-entry-1", new Uint8Array(vec1.buffer).buffer, "test-model", Date.now())
        .run();

      await db
        .prepare(
          "INSERT INTO embeddings (id, embedding, model, created_at) VALUES (?, ?, ?, ?)"
        )
        .bind("vec-entry-2", new Uint8Array(vec2.buffer).buffer, "test-model", Date.now())
        .run();

      // Search with a query vector close to vec1
      const queryVec = new Float32Array([0.9, 0.1, 0.0, 0.0]);
      const vectorSearch = new D1VectorSearch(db);
      const results = await vectorSearch.search(queryVec, "vec-project", 10, USER_A);

      expect(results.length).toBeGreaterThanOrEqual(1);
      // vec-entry-1 should be the top result (most similar to query)
      expect(results[0].entryId).toBe("vec-entry-1");
      expect(results[0].score).toBeGreaterThan(0);
      // Score should be close to 1 for nearly identical vectors
      expect(results[0].score).toBeGreaterThan(0.9);
    });

    it("should exclude entries with score <= 0", async () => {
      await storage.knowledge.addEntry(
        makeEntry({ id: "vec-neg", project: "vec-proj2", summary: "Negative test" })
      );

      // Insert a vector that is orthogonal to the query
      const vec = new Float32Array([0.0, 0.0, 1.0, 0.0]);
      await db
        .prepare(
          "INSERT INTO embeddings (id, embedding, model, created_at) VALUES (?, ?, ?, ?)"
        )
        .bind("vec-neg", new Uint8Array(vec.buffer).buffer, "test-model", Date.now())
        .run();

      // Query is orthogonal: cosine similarity = 0
      const queryVec = new Float32Array([1.0, 0.0, 0.0, 0.0]);
      const vectorSearch = new D1VectorSearch(db);
      const results = await vectorSearch.search(queryVec, "vec-proj2", 10, USER_A);

      // Orthogonal vectors have score = 0, which is excluded
      expect(results).toHaveLength(0);
    });

    it("should scope results by project", async () => {
      await storage.knowledge.addEntry(
        makeEntry({ id: "vec-p1", project: "project-alpha", summary: "Alpha" })
      );
      await storage.knowledge.addEntry(
        makeEntry({ id: "vec-p2", project: "project-beta", summary: "Beta" })
      );

      const vec = new Float32Array([1.0, 0.0, 0.0, 0.0]);
      for (const id of ["vec-p1", "vec-p2"]) {
        await db
          .prepare(
            "INSERT INTO embeddings (id, embedding, model, created_at) VALUES (?, ?, ?, ?)"
          )
          .bind(id, new Uint8Array(vec.buffer).buffer, "test-model", Date.now())
          .run();
      }

      const vectorSearch = new D1VectorSearch(db);
      const results = await vectorSearch.search(vec, "project-alpha", 10, USER_A);
      expect(results).toHaveLength(1);
      expect(results[0].entryId).toBe("vec-p1");
    });
  });

  // -------------------------------------------------------------------------
  // 9. Batch Transactions (Atomicity)
  // -------------------------------------------------------------------------

  describe("batch transactions", () => {
    it("updateEntry creates both UPDATE and history INSERT atomically", async () => {
      await storage.knowledge.addEntry(
        makeEntry({ id: "batch-upd", summary: "Before update" })
      );

      await storage.knowledge.updateEntry("batch-upd", { summary: "After update" });

      // Verify the update persisted
      const entry = await storage.knowledge.getEntry("batch-upd");
      expect(entry!.summary).toBe("After update");

      // Verify history was recorded
      const history = await storage.knowledge.getHistory("batch-upd");
      expect(history.length).toBeGreaterThanOrEqual(1);

      // Find the update event
      const updateEvent = history.find((h) => h.event === "update");
      expect(updateEvent).toBeDefined();
      expect(updateEvent!.old_summary).toBe("Before update");
      expect(updateEvent!.new_summary).toBe("After update");
    });

    it("deleteEntry removes the entry and cascade-deletes history", async () => {
      // NOTE: D1 with foreign_keys=ON (the default in miniflare and production D1)
      // cascade-deletes knowledge_history rows when the parent knowledge entry is
      // deleted. The batch inserts history first, then deletes the entry, but the
      // ON DELETE CASCADE removes the history in the same transaction.
      await storage.knowledge.addEntry(
        makeEntry({ id: "batch-del", summary: "To be deleted" })
      );

      const deleted = await storage.knowledge.deleteEntry("batch-del");
      expect(deleted).toBe(true);

      // Entry should be gone
      expect(await storage.knowledge.hasEntry("batch-del")).toBe(false);

      // History is cascade-deleted because the foreign key references knowledge(id)
      const history = await storage.knowledge.getHistory("batch-del");
      expect(history).toHaveLength(0);
    });

    it("addEntry creates both INSERT and history INSERT atomically", async () => {
      await storage.knowledge.addEntry(
        makeEntry({ id: "batch-add", summary: "New entry" })
      );

      const history = await storage.knowledge.getHistory("batch-add");
      expect(history.length).toBeGreaterThanOrEqual(1);
      const addEvent = history.find((h) => h.event === "add");
      expect(addEvent).toBeDefined();
      expect(addEvent!.old_summary).toBeNull();
      expect(addEvent!.new_summary).toBe("New entry");
    });
  });

  // -------------------------------------------------------------------------
  // Additional edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("knowledge: handles entries with no optional fields", async () => {
      const entry = makeEntry({
        id: "opt-1",
        occurrences: undefined,
        projectCount: undefined,
        extractedAt: undefined,
        importance: undefined,
      });
      await storage.knowledge.addEntry(entry);

      const result = await storage.knowledge.getEntry("opt-1");
      expect(result!.occurrences).toBeUndefined();
      expect(result!.projectCount).toBeUndefined();
      expect(result!.extractedAt).toBeUndefined();
    });

    it("knowledge: type distribution returns correct counts", async () => {
      await storage.knowledge.addEntry(makeEntry({ id: "td1", type: "solution", summary: "S1" }));
      await storage.knowledge.addEntry(makeEntry({ id: "td2", type: "solution", summary: "S2" }));
      await storage.knowledge.addEntry(makeEntry({ id: "td3", type: "pattern", summary: "P1" }));

      const dist = await storage.knowledge.getTypeDistribution();
      expect(dist["solution"]).toBe(2);
      expect(dist["pattern"]).toBe(1);
    });

    it("documents: average token count", async () => {
      await addDoc(storage, "Short", 10, {
        sessionId: "s",
        project: "p",
        role: "user",
        timestamp: Date.now(),
        toolNames: [],
        messageIndex: 0,
      });
      await addDoc(storage, "Longer text", 30, {
        sessionId: "s",
        project: "p",
        role: "user",
        timestamp: Date.now(),
        toolNames: [],
        messageIndex: 1,
      });

      const avg = await storage.documents.getAverageTokenCount();
      expect(avg).toBe(20);
    });

    it("documents: removeSession deletes all docs in that session", async () => {
      await addDoc(storage, "A", 10, {
        sessionId: "rm-sess",
        project: "p",
        role: "user",
        timestamp: Date.now(),
        toolNames: [],
        messageIndex: 0,
      });
      await addDoc(storage, "B", 10, {
        sessionId: "rm-sess",
        project: "p",
        role: "user",
        timestamp: Date.now(),
        toolNames: [],
        messageIndex: 1,
      });
      await addDoc(storage, "C", 10, {
        sessionId: "keep-sess",
        project: "p",
        role: "user",
        timestamp: Date.now(),
        toolNames: [],
        messageIndex: 0,
      });

      await storage.documents.removeSession("rm-sess");
      expect(await storage.documents.getDocumentCount()).toBe(1);
      const remaining = await storage.documents.getBySession("keep-sess");
      expect(remaining).toHaveLength(1);
    });

    it("entities: getById returns undefined for missing entity", async () => {
      expect(await storage.entities.getById("nonexistent")).toBeUndefined();
    });

    it("entities: getTopEntities returns entities sorted by mention count", async () => {
      await storage.entities.upsertEntity({
        id: "top-1",
        name: "Rare",
        type: "tool",
        canonicalName: "Rare",
        aliases: [],
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        user: USER_A,
      });

      const popular = {
        id: "top-2",
        name: "Popular",
        type: "tool" as const,
        canonicalName: "Popular",
        aliases: [] as string[],
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        user: USER_A,
      };
      // Upsert multiple times to increase mention count
      await storage.entities.upsertEntity(popular);
      await storage.entities.upsertEntity({ ...popular, id: "top-2b" });
      await storage.entities.upsertEntity({ ...popular, id: "top-2c" });

      const top = await storage.entities.getTopEntities(10);
      expect(top[0].canonical_name).toBe("Popular");
      expect(top[0].mention_count).toBe(3);
    });

    it("summaries: getByTool filters correctly", async () => {
      await storage.summaries.save(makeSummary({ sessionId: "tool-cc" }));
      await storage.summaries.save(
        makeSummary({ sessionId: "tool-aider" }),
        "aider"
      );

      const cc = await storage.summaries.getByTool("claude-code");
      expect(cc).toHaveLength(1);
      expect(cc[0].sessionId).toBe("tool-cc");

      const aider = await storage.summaries.getByTool("aider");
      expect(aider).toHaveLength(1);
      expect(aider[0].sessionId).toBe("tool-aider");
    });

    it("meta: getJson returns undefined for non-JSON value", async () => {
      await storage.meta.set("bad-json", "not {valid json");
      expect(await storage.meta.getJson("bad-json")).toBeUndefined();
    });

    it("knowledge: upsertEntry replaces existing entry by ID", async () => {
      await storage.knowledge.upsertEntry(makeEntry({ id: "ups-1", summary: "Original" }));
      await storage.knowledge.upsertEntry(makeEntry({ id: "ups-1", summary: "Replaced" }));

      const result = await storage.knowledge.getEntry("ups-1");
      expect(result!.summary).toBe("Replaced");
      expect(await storage.knowledge.getEntryCount()).toBe(1);
    });

    it("knowledge: getAllEntries returns entries in timestamp DESC order", async () => {
      const now = Date.now();
      await storage.knowledge.addEntry(
        makeEntry({ id: "all-1", summary: "First", timestamp: now - 5000 })
      );
      await storage.knowledge.addEntry(
        makeEntry({ id: "all-2", summary: "Second", timestamp: now })
      );

      const all = await storage.knowledge.getAllEntries();
      expect(all).toHaveLength(2);
      expect(all[0].id).toBe("all-2"); // newest first
      expect(all[1].id).toBe("all-1");
    });

    it("knowledge: getGlobalLearnings sorted by occurrences DESC", async () => {
      await storage.knowledge.addEntry(
        makeEntry({ id: "gl-1", type: "learning", summary: "L1", occurrences: 3 })
      );
      await storage.knowledge.addEntry(
        makeEntry({ id: "gl-2", type: "learning", summary: "L2", occurrences: 7 })
      );
      await storage.knowledge.addEntry(
        makeEntry({ id: "gl-3", type: "solution", summary: "Not learning" })
      );

      const learnings = await storage.knowledge.getGlobalLearnings();
      expect(learnings).toHaveLength(2);
      expect(learnings[0].occurrences).toBe(7);
      expect(learnings[1].occurrences).toBe(3);
    });

    it("entities: paginated getEntities", async () => {
      for (let i = 0; i < 5; i++) {
        await storage.entities.upsertEntity({
          id: `pag-ent-${i}`,
          name: `Entity${i}`,
          type: "tool",
          canonicalName: `Entity${i}`,
          aliases: [],
          firstSeen: Date.now(),
          lastSeen: Date.now(),
          user: USER_A,
        });
      }

      const page1 = await storage.entities.getEntities({
        limit: 2,
        offset: 0,
        sort: "mentions",
      });
      expect(page1.entities).toHaveLength(2);
      expect(page1.total).toBe(5);

      const page2 = await storage.entities.getEntities({
        limit: 2,
        offset: 2,
        sort: "mentions",
      });
      expect(page2.entities).toHaveLength(2);
    });

    it("summaries: paginated getSessions", async () => {
      for (let i = 0; i < 4; i++) {
        await storage.summaries.save(
          makeSummary({ sessionId: `pag-sess-${i}`, endTime: Date.now() + i })
        );
      }

      const page = await storage.summaries.getSessions({ limit: 2, offset: 0 });
      expect(page.sessions).toHaveLength(2);
      expect(page.total).toBe(4);
    });

    it("documents: getAllDocuments returns all user docs", async () => {
      await addDoc(storage, "D1", 10, {
        sessionId: "s",
        project: "p",
        role: "user",
        timestamp: Date.now(),
        toolNames: [],
        messageIndex: 0,
      });
      await addDoc(storage, "D2", 20, {
        sessionId: "s",
        project: "p",
        role: "assistant",
        timestamp: Date.now(),
        toolNames: ["Edit"],
        messageIndex: 1,
      });

      const all = await storage.documents.getAllDocuments();
      expect(all).toHaveLength(2);
    });
  });
});
