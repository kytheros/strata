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
    it("should save and retrieve a summary", () => {
      const summary = makeSummary({ sessionId: "s1", topic: "Docker setup" });
      store.save(summary);

      const result = store.get("s1");
      expect(result).toBeDefined();
      expect(result!.sessionId).toBe("s1");
      expect(result!.topic).toBe("Docker setup");
      expect(result!.toolsUsed).toEqual(["Read", "Write"]);
      expect(result!.messageCount).toBe(10);
    });

    it("should return null for non-existent session", () => {
      expect(store.get("non-existent")).toBeNull();
    });

    it("should upsert (replace) on same session ID", () => {
      store.save(makeSummary({ sessionId: "s1", topic: "Original" }));
      store.save(makeSummary({ sessionId: "s1", topic: "Updated" }));

      expect(store.getCount()).toBe(1);
      expect(store.get("s1")!.topic).toBe("Updated");
    });

    it("should store the tool field", () => {
      store.save(makeSummary({ sessionId: "s1" }), "codex");
      const row = db.prepare("SELECT tool FROM summaries WHERE session_id = ?").get("s1") as { tool: string };
      expect(row.tool).toBe("codex");
    });
  });

  describe("getByProject", () => {
    it("should return summaries for a project", () => {
      store.save(makeSummary({ sessionId: "s1", project: "my-project" }));
      store.save(makeSummary({ sessionId: "s2", project: "other-project" }));

      const results = store.getByProject("my-project");
      expect(results).toHaveLength(1);
      expect(results[0].project).toBe("my-project");
    });
  });

  describe("getByTool", () => {
    it("should return summaries filtered by tool", () => {
      store.save(makeSummary({ sessionId: "s1" }), "claude-code");
      store.save(makeSummary({ sessionId: "s2" }), "codex");

      const results = store.getByTool("codex");
      expect(results).toHaveLength(1);
      expect(results[0].sessionId).toBe("s2");
    });
  });

  describe("getRecent", () => {
    it("should return most recent summaries", () => {
      store.save(makeSummary({ sessionId: "s1", endTime: 100 }));
      store.save(makeSummary({ sessionId: "s2", endTime: 300 }));
      store.save(makeSummary({ sessionId: "s3", endTime: 200 }));

      const results = store.getRecent(2);
      expect(results).toHaveLength(2);
      expect(results[0].sessionId).toBe("s2"); // Most recent
      expect(results[1].sessionId).toBe("s3");
    });
  });

  describe("remove", () => {
    it("should remove a summary", () => {
      store.save(makeSummary({ sessionId: "s1" }));
      store.remove("s1");
      expect(store.get("s1")).toBeNull();
      expect(store.getCount()).toBe(0);
    });
  });

  describe("getAll", () => {
    it("should return all summaries", () => {
      store.save(makeSummary({ sessionId: "s1" }));
      store.save(makeSummary({ sessionId: "s2" }));
      expect(store.getAll()).toHaveLength(2);
    });
  });

  describe("getCount", () => {
    it("should return 0 for empty store", () => {
      expect(store.getCount()).toBe(0);
    });

    it("should return correct count", () => {
      store.save(makeSummary({ sessionId: "s1" }));
      store.save(makeSummary({ sessionId: "s2" }));
      expect(store.getCount()).toBe(2);
    });
  });

  describe("full summary data preservation", () => {
    it("should preserve all summary fields through round-trip", () => {
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

      store.save(original);
      const loaded = store.get("s1")!;

      expect(loaded).toEqual(original);
    });
  });
});
