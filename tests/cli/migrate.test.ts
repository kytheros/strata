import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import { SqliteSummaryStore } from "../../src/storage/sqlite-summary-store.js";
import { migrate, shouldMigrate, autoMigrate } from "../../src/cli/migrate.js";
import type { DocumentChunk } from "../../src/indexing/document-store.js";
import type { KnowledgeEntry } from "../../src/knowledge/knowledge-store.js";
import type { SessionSummary } from "../../src/knowledge/session-summarizer.js";

/** Create a temp directory for each test run */
function makeTempDir(): string {
  const dir = join(tmpdir(), `strata-migrate-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeDocument(overrides: Partial<DocumentChunk> = {}): DocumentChunk {
  return {
    id: randomUUID(),
    sessionId: "session-1",
    project: "/test/project",
    text: "hello world from a test document",
    role: "user",
    timestamp: Date.now(),
    toolNames: ["Read"],
    tokenCount: 8,
    messageIndex: 0,
    ...overrides,
  };
}

function makeKnowledgeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: randomUUID(),
    type: "solution",
    project: "/test/project",
    sessionId: "session-1",
    timestamp: Date.now(),
    summary: "How to fix the frobulator",
    details: "Adjust the flux capacitor settings",
    tags: ["debugging"],
    relatedFiles: ["src/frobulator.ts"],
    ...overrides,
  };
}

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "session-1",
    project: "/test/project",
    projectName: "test-project",
    startTime: Date.now() - 60000,
    endTime: Date.now(),
    duration: 60000,
    messageCount: 10,
    userMessageCount: 5,
    topic: "Testing migration",
    keyTopics: ["migration", "sqlite"],
    toolsUsed: ["Read", "Write"],
    filesReferenced: ["src/migrate.ts"],
    hasCodeChanges: true,
    lastUserMessage: "Done!",
    ...overrides,
  };
}

/** Write a legacy index.json with the given documents */
function writeLegacyIndex(legacyDir: string, documents: DocumentChunk[]): void {
  const data = {
    bm25: { index: {}, docLengths: {}, totalDocs: 0, avgDocLength: 0 },
    tfidf: { terms: {}, norms: {} },
    documents: { documents },
    meta: { lastIndexed: {}, buildTime: Date.now(), version: 1 },
  };
  writeFileSync(join(legacyDir, "index.json"), JSON.stringify(data));
}

/** Write legacy knowledge.json */
function writeLegacyKnowledge(legacyDir: string, entries: KnowledgeEntry[]): void {
  writeFileSync(join(legacyDir, "knowledge.json"), JSON.stringify(entries));
}

/** Write legacy summaries */
function writeLegacySummaries(legacyDir: string, summaries: SessionSummary[]): void {
  const dir = join(legacyDir, "summaries");
  mkdirSync(dir, { recursive: true });
  for (const s of summaries) {
    writeFileSync(join(dir, `${s.sessionId}.json`), JSON.stringify(s));
  }
}

describe("migrate", () => {
  let legacyDir: string;
  let dbPath: string;
  const logs: string[] = [];

  beforeEach(() => {
    legacyDir = makeTempDir();
    dbPath = ":memory:";
    logs.length = 0;
  });

  afterEach(() => {
    try {
      rmSync(legacyDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  describe("shouldMigrate", () => {
    it("returns false when legacy directory does not exist", async () => {
      expect(shouldMigrate(join(legacyDir, "nonexistent"))).toBe(false);
    });

    it("returns false when .migrated marker exists", async () => {
      writeLegacyIndex(legacyDir, [makeDocument()]);
      writeFileSync(join(legacyDir, ".migrated"), "done");
      expect(shouldMigrate(legacyDir)).toBe(false);
    });

    it("returns true when legacy data exists without marker", async () => {
      writeLegacyIndex(legacyDir, [makeDocument()]);
      expect(shouldMigrate(legacyDir)).toBe(true);
    });

    it("returns true when only knowledge.json exists", async () => {
      writeLegacyKnowledge(legacyDir, [makeKnowledgeEntry()]);
      expect(shouldMigrate(legacyDir)).toBe(true);
    });

    it("returns false when directory is empty", async () => {
      expect(shouldMigrate(legacyDir)).toBe(false);
    });
  });

  describe("full migration", () => {
    it("migrates documents, knowledge, and summaries", async () => {
      const docs = [
        makeDocument({ sessionId: "s1", messageIndex: 0 }),
        makeDocument({ sessionId: "s1", messageIndex: 1 }),
        makeDocument({ sessionId: "s2", messageIndex: 0 }),
      ];
      const knowledge = [
        makeKnowledgeEntry({ id: "k1" }),
        makeKnowledgeEntry({ id: "k2", type: "pattern", summary: "Different summary" }),
      ];
      const summaries = [
        makeSummary({ sessionId: "s1" }),
        makeSummary({ sessionId: "s2" }),
      ];

      writeLegacyIndex(legacyDir, docs);
      writeLegacyKnowledge(legacyDir, knowledge);
      writeLegacySummaries(legacyDir, summaries);

      const result = await migrate({
        legacyDir,
        dbPath,
        log: (msg) => logs.push(msg),
      });

      expect(result.skipped).toBe(false);
      expect(result.documents).toBe(3);
      expect(result.sessions).toBe(2);
      expect(result.knowledge).toBe(2);
      expect(result.summaries).toBe(2);
      expect(result.errors).toHaveLength(0);

      // Marker file should exist
      expect(existsSync(join(legacyDir, ".migrated"))).toBe(true);
    });

    it("creates .migrated marker with metadata", async () => {
      writeLegacyIndex(legacyDir, [makeDocument()]);

      await migrate({
        legacyDir,
        dbPath,
        log: () => {},
      });

      const marker = JSON.parse(readFileSync(join(legacyDir, ".migrated"), "utf-8"));
      expect(marker.migratedAt).toBeDefined();
      expect(marker.documents).toBe(1);
    });
  });

  describe("idempotency", () => {
    it("skips migration when marker file exists", async () => {
      writeLegacyIndex(legacyDir, [makeDocument()]);

      // First migration
      await migrate({
        legacyDir,
        dbPath,
        log: () => {},
      });

      // Second migration should skip
      const result = await migrate({
        legacyDir,
        dbPath,
        log: (msg) => logs.push(msg),
      });

      expect(result.skipped).toBe(true);
      expect(logs.some((l) => l.includes("already completed"))).toBe(true);
    });

    it("force flag bypasses marker check", async () => {
      writeLegacyIndex(legacyDir, [makeDocument()]);

      await migrate({ legacyDir, dbPath, log: () => {} });

      // Force re-migration
      const result = await migrate({
        legacyDir,
        dbPath,
        force: true,
        log: () => {},
      });

      expect(result.skipped).toBe(false);
      expect(result.documents).toBe(1);
    });
  });

  describe("corrupt/missing data handling", () => {
    it("handles missing index files gracefully", async () => {
      // Only write knowledge, no index file
      writeLegacyKnowledge(legacyDir, [makeKnowledgeEntry()]);

      const result = await migrate({
        legacyDir,
        dbPath,
        log: (msg) => logs.push(msg),
      });

      expect(result.documents).toBe(0);
      expect(result.knowledge).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it("handles corrupt index.json gracefully", async () => {
      writeFileSync(join(legacyDir, "index.json"), "not valid json {{{");

      const result = await migrate({
        legacyDir,
        dbPath,
        log: (msg) => logs.push(msg),
      });

      expect(result.documents).toBe(0);
      expect(result.errors.some((e) => e.includes("index.json"))).toBe(true);
    });

    it("handles corrupt knowledge.json gracefully", async () => {
      writeFileSync(join(legacyDir, "knowledge.json"), "broken!!!");

      const result = await migrate({
        legacyDir,
        dbPath,
        log: (msg) => logs.push(msg),
      });

      expect(result.knowledge).toBe(0);
      expect(result.errors.some((e) => e.includes("knowledge.json"))).toBe(true);
    });

    it("handles corrupt summary files gracefully", async () => {
      const dir = join(legacyDir, "summaries");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "bad.json"), "not json");
      writeLegacySummaries(legacyDir, [makeSummary({ sessionId: "good" })]);

      const result = await migrate({
        legacyDir,
        dbPath,
        log: (msg) => logs.push(msg),
      });

      // Should have migrated the good one
      expect(result.summaries).toBe(1);
      // Should have logged a warning about the bad one
      expect(result.errors.some((e) => e.includes("bad.json"))).toBe(true);
    });
  });

  describe("empty data", () => {
    it("handles empty index gracefully", async () => {
      writeLegacyIndex(legacyDir, []);

      const result = await migrate({
        legacyDir,
        dbPath,
        log: (msg) => logs.push(msg),
      });

      expect(result.documents).toBe(0);
      expect(result.sessions).toBe(0);
      expect(result.skipped).toBe(false);
    });

    it("handles empty knowledge array gracefully", async () => {
      writeLegacyKnowledge(legacyDir, []);

      const result = await migrate({
        legacyDir,
        dbPath,
        log: (msg) => logs.push(msg),
      });

      expect(result.knowledge).toBe(0);
    });

    it("handles empty summaries directory gracefully", async () => {
      mkdirSync(join(legacyDir, "summaries"), { recursive: true });

      const result = await migrate({
        legacyDir,
        dbPath,
        log: (msg) => logs.push(msg),
      });

      expect(result.summaries).toBe(0);
    });
  });

  describe("autoMigrate", () => {
    it("does nothing when no legacy data exists", async () => {
      const emptyDir = join(legacyDir, "nonexistent");

      await autoMigrate({
        legacyDir: emptyDir,
        dbPath,
        log: (msg) => logs.push(msg),
      });

      // Should not have logged anything about migration
      expect(logs).toHaveLength(0);
    });

    it("auto-migrates when legacy data exists", async () => {
      writeLegacyIndex(legacyDir, [makeDocument()]);
      writeLegacyKnowledge(legacyDir, [makeKnowledgeEntry()]);

      await autoMigrate({
        legacyDir,
        dbPath,
        log: (msg) => logs.push(msg),
      });

      expect(logs.some((l) => l.includes("auto-migration"))).toBe(true);
      expect(existsSync(join(legacyDir, ".migrated"))).toBe(true);
    });
  });

  describe("data preservation", () => {
    it("preserves document metadata through migration", async () => {
      const doc = makeDocument({
        sessionId: "ses-abc",
        project: "/home/user/myproject",
        role: "assistant",
        timestamp: 1700000000000,
        toolNames: ["Read", "Write", "Bash"],
        tokenCount: 42,
        messageIndex: 5,
      });

      writeLegacyIndex(legacyDir, [doc]);

      // Use a file-based DB so we can verify after migration
      const tempDbDir = makeTempDir();
      const tempDbPath = join(tempDbDir, "test.db");

      await migrate({
        legacyDir,
        dbPath: tempDbPath,
        log: () => {},
      });

      // Re-open DB and verify
      const db = openDatabase(tempDbPath);
      const store = new SqliteDocumentStore(db);
      const docs = await store.getBySession("ses-abc");

      expect(docs).toHaveLength(1);
      expect(docs[0].sessionId).toBe("ses-abc");
      expect(docs[0].project).toBe("/home/user/myproject");
      expect(docs[0].role).toBe("assistant");
      expect(docs[0].timestamp).toBe(1700000000000);
      expect(docs[0].toolNames).toEqual(["Read", "Write", "Bash"]);
      expect(docs[0].tokenCount).toBe(42);
      expect(docs[0].messageIndex).toBe(5);
      expect(docs[0].text).toBe(doc.text);

      db.close();
      rmSync(tempDbDir, { recursive: true, force: true });
    });
  });
});
