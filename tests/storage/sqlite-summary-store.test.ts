import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteSummaryStore } from "../../src/storage/sqlite-summary-store.js";
import type { SessionSummary } from "../../src/knowledge/session-summarizer.js";

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: `session-${Math.random().toString(36).slice(2, 8)}`,
    project: "test-project",
    projectName: "test-project",
    startTime: 1000,
    endTime: 2000,
    duration: 1000,
    messageCount: 10,
    userMessageCount: 5,
    topic: "Test topic",
    keyTopics: ["test"],
    toolsUsed: ["Read", "Write"],
    filesReferenced: ["file.ts"],
    hasCodeChanges: true,
    lastUserMessage: "Last message",
    ...overrides,
  };
}

describe("SqliteSummaryStore", () => {
  let db: Database.Database;
  let store: SqliteSummaryStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new SqliteSummaryStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("save and get", () => {
    it("should save and retrieve a summary", async () => {
      const summary = makeSummary({ sessionId: "s1", topic: "Docker setup" });
      await store.save(summary);

      const result = await store.get("s1");
      expect(result).toBeDefined();
      expect(result!.sessionId).toBe("s1");
      expect(result!.topic).toBe("Docker setup");
      expect(result!.toolsUsed).toEqual(["Read", "Write"]);
      expect(result!.messageCount).toBe(10);
    });

    it("should return null for non-existent session", async () => {
      expect(await store.get("non-existent")).toBeNull();
    });

    it("should upsert (replace) on same session ID", async () => {
      await store.save(makeSummary({ sessionId: "s1", topic: "Original" }));
      await store.save(makeSummary({ sessionId: "s1", topic: "Updated" }));

      expect(await store.getCount()).toBe(1);
      expect((await store.get("s1"))!.topic).toBe("Updated");
    });

    it("should store the tool field", async () => {
      await store.save(makeSummary({ sessionId: "s1" }), "codex");
      const row = db.prepare("SELECT tool FROM summaries WHERE session_id = ?").get("s1") as { tool: string };
      expect(row.tool).toBe("codex");
    });
  });

  describe("getByProject", () => {
    it("should return summaries for a project", async () => {
      await store.save(makeSummary({ sessionId: "s1", project: "my-project" }));
      await store.save(makeSummary({ sessionId: "s2", project: "other-project" }));

      const results = await store.getByProject("my-project");
      expect(results).toHaveLength(1);
      expect(results[0].project).toBe("my-project");
    });
  });

  describe("getByTool", () => {
    it("should return summaries filtered by tool", async () => {
      await store.save(makeSummary({ sessionId: "s1" }), "claude-code");
      await store.save(makeSummary({ sessionId: "s2" }), "codex");

      const results = await store.getByTool("codex");
      expect(results).toHaveLength(1);
      expect(results[0].sessionId).toBe("s2");
    });
  });

  describe("getRecent", () => {
    it("should return most recent summaries", async () => {
      await store.save(makeSummary({ sessionId: "s1", endTime: 100 }));
      await store.save(makeSummary({ sessionId: "s2", endTime: 300 }));
      await store.save(makeSummary({ sessionId: "s3", endTime: 200 }));

      const results = await store.getRecent(2);
      expect(results).toHaveLength(2);
      expect(results[0].sessionId).toBe("s2"); // Most recent
      expect(results[1].sessionId).toBe("s3");
    });
  });

  describe("remove", () => {
    it("should remove a summary", async () => {
      await store.save(makeSummary({ sessionId: "s1" }));
      await store.remove("s1");
      expect(await store.get("s1")).toBeNull();
      expect(await store.getCount()).toBe(0);
    });
  });

  describe("getAll", () => {
    it("should return all summaries", async () => {
      await store.save(makeSummary({ sessionId: "s1" }));
      await store.save(makeSummary({ sessionId: "s2" }));
      expect(await store.getAll()).toHaveLength(2);
    });
  });

  describe("getCount", () => {
    it("should return 0 for empty store", async () => {
      expect(await store.getCount()).toBe(0);
    });

    it("should return correct count", async () => {
      await store.save(makeSummary({ sessionId: "s1" }));
      await store.save(makeSummary({ sessionId: "s2" }));
      expect(await store.getCount()).toBe(2);
    });
  });

  describe("full summary data preservation", () => {
    it("should preserve all summary fields through round-trip", async () => {
      const original = makeSummary({
        sessionId: "s1",
        project: "/path/to/project",
        projectName: "project",
        startTime: 1710000000000,
        endTime: 1710003600000,
        duration: 3600000,
        messageCount: 42,
        userMessageCount: 21,
        topic: "Implementing search feature",
        keyTopics: ["search", "fts5", "sqlite"],
        toolsUsed: ["Read", "Write", "Bash"],
        filesReferenced: ["src/search.ts", "tests/search.test.ts"],
        hasCodeChanges: true,
        lastUserMessage: "Run the tests please",
      });

      await store.save(original);
      const loaded = await store.get("s1")!;

      expect(loaded).toEqual(original);
    });
  });
});
