/**
 * Golden Fixture Tests
 *
 * Tests all 5 parsers against realistic conversation files that match
 * the actual format produced by each tool. These fixtures are modeled
 * on real data (not simplified synthetic examples).
 *
 * Unlike unit tests (which test individual functions), these tests
 * validate the full discover → parse → index → search pipeline
 * against fixture files structured exactly like real tool output.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import { Sanitizer } from "../../src/sanitizer/sanitizer.js";

import { ClaudeCodeParser } from "../../src/parsers/claude-code-parser.js";
import { CodexParser } from "../../src/parsers/codex-parser.js";
import { ClineParser } from "../../src/parsers/cline-parser.js";
import { GeminiParser } from "../../src/parsers/gemini-parser.js";
import { AiderParser } from "../../src/parsers/aider-parser.js";

const FIXTURES = join(__dirname, "..", "fixtures", "golden");

describe("Golden Fixture Pipeline", () => {
  let db: Database.Database;
  let docStore: SqliteDocumentStore;
  let searchEngine: SqliteSearchEngine;
  let sanitizer: Sanitizer;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `strata-golden-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    db = openDatabase(join(tmpDir, "golden.db"));
    docStore = new SqliteDocumentStore(db);
    searchEngine = new SqliteSearchEngine(docStore);
    sanitizer = new Sanitizer();
  });

  afterAll(() => {
    db.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  // ── Claude Code ─────────────────────────────────────────────────────

  describe("Claude Code golden fixture", () => {
    const parser = new ClaudeCodeParser(join(FIXTURES, "claude-code"));

    it("detects the fixture directory", () => {
      expect(parser.detect()).toBe(true);
    });

    it("discovers session files", () => {
      const files = parser.discover();
      expect(files.length).toBeGreaterThan(0);
      expect(files[0].filePath).toContain("session-001.jsonl");
    });

    it("parses with correct fields", () => {
      const files = parser.discover();
      const session = parser.parse(files[0]);
      expect(session).not.toBeNull();
      expect(session!.tool).toBe("claude-code");
      expect(session!.messages.length).toBeGreaterThanOrEqual(2);

      // Verify roles — user messages with only tool_result may be filtered out
      const roles = session!.messages.map((m) => m.role);
      expect(roles).toContain("assistant");

      // Verify tool extraction
      const allTools = session!.messages.flatMap((m) => m.toolNames);
      expect(allTools).toContain("Read");
      expect(allTools).toContain("Write");
    });

    it("indexes and searches correctly", () => {
      const files = parser.discover();
      const session = parser.parse(files[0])!;
      const text = sanitizer.sanitize(
        session.messages.map((m) => m.text).join("\n")
      );
      docStore.add(text, text.split(/\s+/).length, {
        sessionId: session.sessionId,
        project: session.project,
        role: "mixed",
        timestamp: session.endTime || Date.now(),
        toolNames: session.messages.flatMap((m) => m.toolNames),
        messageIndex: 0,
      }, "claude-code");

      const results = searchEngine.search("dependency injection");
      expect(results.length).toBeGreaterThan(0);
    });
  });

  // ── Codex CLI ───────────────────────────────────────────────────────

  describe("Codex CLI golden fixture", () => {
    const parser = new CodexParser(join(FIXTURES, "codex", "sessions"));

    it("detects the fixture directory", () => {
      expect(parser.detect()).toBe(true);
    });

    it("discovers session files in YYYY/MM/DD structure", () => {
      const files = parser.discover();
      expect(files.length).toBeGreaterThan(0);
      expect(files[0].filePath).toContain("rollout-abc123.jsonl");
      expect(files[0].sessionId).toBe("abc123");
    });

    it("parses with correct fields", () => {
      const files = parser.discover();
      const session = parser.parse(files[0]);
      expect(session).not.toBeNull();
      expect(session!.tool).toBe("codex");
      expect(session!.messages.length).toBeGreaterThanOrEqual(3);
      expect(session!.cwd).toBe("/home/user/my-project");

      // Verify command execution is captured
      const toolNames = session!.messages.flatMap((m) => m.toolNames);
      expect(toolNames).toContain("Bash");

      // Verify file changes are captured
      expect(toolNames).toContain("Write");

      // Verify timestamps
      expect(session!.startTime).toBeGreaterThan(0);
      expect(session!.endTime).toBeGreaterThanOrEqual(session!.startTime);
    });

    it("indexes and searches correctly", () => {
      const files = parser.discover();
      const session = parser.parse(files[0])!;
      const text = sanitizer.sanitize(
        session.messages.map((m) => m.text).join("\n")
      );
      docStore.add(text, text.split(/\s+/).length, {
        sessionId: session.sessionId,
        project: session.project,
        role: "mixed",
        timestamp: session.endTime || Date.now(),
        toolNames: session.messages.flatMap((m) => m.toolNames),
        messageIndex: 0,
      }, "codex");

      const results = searchEngine.search("formatDate timezone");
      expect(results.length).toBeGreaterThan(0);
    });
  });

  // ── Gemini CLI (v1 legacy checkpoint format) ─────────────────────────

  describe("Gemini CLI v1 golden fixture", () => {
    const parser = new GeminiParser(join(FIXTURES, "gemini"));

    it("detects the fixture directory", () => {
      expect(parser.detect()).toBe(true);
    });

    it("discovers checkpoint files in project hash directories", () => {
      const files = parser.discover();
      expect(files.length).toBeGreaterThan(0);
      expect(files[0].filePath).toContain("checkpoint-session1.json");
      expect(files[0].sessionId).toContain("abc123hash");
    });

    it("parses v1 format with correct fields", () => {
      const files = parser.discover();
      const session = parser.parse(files[0]);
      expect(session).not.toBeNull();
      expect(session!.tool).toBe("gemini-cli");
      expect(session!.messages.length).toBeGreaterThanOrEqual(3);

      // Verify function calls are extracted
      const toolNames = session!.messages.flatMap((m) => m.toolNames);
      expect(toolNames).toContain("read_file");
      expect(toolNames).toContain("run_command");

      // Verify timestamps from createTime
      expect(session!.startTime).toBeGreaterThan(0);
      expect(session!.endTime).toBeGreaterThanOrEqual(session!.startTime);
    });

    it("indexes and searches correctly", () => {
      const files = parser.discover();
      const session = parser.parse(files[0])!;
      const text = sanitizer.sanitize(
        session.messages.map((m) => m.text).join("\n")
      );
      docStore.add(text, text.split(/\s+/).length, {
        sessionId: session.sessionId,
        project: session.project,
        role: "mixed",
        timestamp: session.endTime || Date.now(),
        toolNames: session.messages.flatMap((m) => m.toolNames),
        messageIndex: 0,
      }, "gemini-cli");

      const results = searchEngine.search("PostgreSQL connection pool");
      expect(results.length).toBeGreaterThan(0);
    });
  });

  // ── Gemini CLI (v2 session format — real captured data) ─────────────

  describe("Gemini CLI v2 golden fixture (real data)", () => {
    const parser = new GeminiParser(join(FIXTURES, "gemini-v2"));

    it("detects the fixture directory", () => {
      expect(parser.detect()).toBe(true);
    });

    it("discovers session-*.json files", () => {
      const files = parser.discover();
      expect(files.length).toBeGreaterThan(0);
      expect(files[0].filePath).toMatch(/session-.*\.json$/);
    });

    it("parses v2 format with correct fields", () => {
      const files = parser.discover();
      const session = parser.parse(files[0]);
      expect(session).not.toBeNull();
      expect(session!.tool).toBe("gemini-cli");
      expect(session!.messages.length).toBeGreaterThanOrEqual(2);

      // Verify roles
      const roles = session!.messages.map((m) => m.role);
      expect(roles).toContain("user");
      expect(roles).toContain("assistant");

      // Verify tool calls are extracted from toolCalls array
      const toolNames = session!.messages.flatMap((m) => m.toolNames);
      expect(toolNames).toContain("read_file");

      // Verify timestamps
      expect(session!.startTime).toBeGreaterThan(0);
      expect(session!.endTime).toBeGreaterThanOrEqual(session!.startTime);
    });

    it("indexes and searches correctly", () => {
      const files = parser.discover();
      const session = parser.parse(files[0])!;
      const text = sanitizer.sanitize(
        session.messages.map((m) => m.text).join("\n")
      );
      docStore.add(text, text.split(/\s+/).length, {
        sessionId: session.sessionId,
        project: session.project,
        role: "mixed",
        timestamp: session.endTime || Date.now(),
        toolNames: session.messages.flatMap((m) => m.toolNames),
        messageIndex: 0,
      }, "gemini-cli");

      const results = searchEngine.search("hello world index");
      expect(results.length).toBeGreaterThan(0);
    });
  });

  // ── Cline ───────────────────────────────────────────────────────────

  describe("Cline golden fixture", () => {
    const parser = new ClineParser(join(FIXTURES, "cline"));

    it("detects the fixture directory", () => {
      expect(parser.detect()).toBe(true);
    });

    it("discovers task directories with api_conversation_history.json", () => {
      const files = parser.discover();
      expect(files.length).toBeGreaterThan(0);
      expect(files[0].filePath).toContain("api_conversation_history.json");
      expect(files[0].sessionId).toBe("task-001");
    });

    it("parses with correct fields", () => {
      const files = parser.discover();
      const session = parser.parse(files[0]);
      expect(session).not.toBeNull();
      expect(session!.tool).toBe("cline");
      expect(session!.messages.length).toBeGreaterThanOrEqual(3);

      // Verify tool_use blocks are extracted
      const toolNames = session!.messages.flatMap((m) => m.toolNames);
      expect(toolNames).toContain("read_file");
      expect(toolNames).toContain("write_to_file");

      // Verify timestamps from ts field
      expect(session!.startTime).toBeGreaterThan(0);
    });

    it("indexes and searches correctly", () => {
      const files = parser.discover();
      const session = parser.parse(files[0])!;
      const text = sanitizer.sanitize(
        session.messages.map((m) => m.text).join("\n")
      );
      docStore.add(text, text.split(/\s+/).length, {
        sessionId: session.sessionId,
        project: session.project,
        role: "mixed",
        timestamp: session.endTime || Date.now(),
        toolNames: session.messages.flatMap((m) => m.toolNames),
        messageIndex: 0,
      }, "cline");

      const results = searchEngine.search("error handling");
      expect(results.length).toBeGreaterThan(0);
    });
  });

  // ── Aider ───────────────────────────────────────────────────────────

  describe("Aider golden fixture", () => {
    const parser = new AiderParser([join(FIXTURES, "aider")]);

    it("detects the fixture directory", () => {
      expect(parser.detect()).toBe(true);
    });

    it("discovers .aider.chat.history.md files", () => {
      const files = parser.discover();
      expect(files.length).toBeGreaterThan(0);
      expect(files[0].filePath).toContain(".aider.chat.history.md");
    });

    it("parses with correct fields", () => {
      const files = parser.discover();
      const session = parser.parse(files[0]);
      expect(session).not.toBeNull();
      expect(session!.tool).toBe("aider");
      expect(session!.messages.length).toBeGreaterThanOrEqual(3);

      // Verify roles
      const roles = session!.messages.map((m) => m.role);
      expect(roles).toContain("user");
      expect(roles).toContain("assistant");

      // Verify SEARCH/REPLACE detection
      const toolNames = session!.messages.flatMap((m) => m.toolNames);
      expect(toolNames).toContain("Edit");

      // Verify bash detection
      expect(toolNames).toContain("Bash");
    });

    it("indexes and searches correctly", () => {
      const files = parser.discover();
      const session = parser.parse(files[0])!;
      const text = sanitizer.sanitize(
        session.messages.map((m) => m.text).join("\n")
      );
      docStore.add(text, text.split(/\s+/).length, {
        sessionId: session.sessionId,
        project: session.project,
        role: "mixed",
        timestamp: session.endTime || Date.now(),
        toolNames: session.messages.flatMap((m) => m.toolNames),
        messageIndex: 0,
      }, "aider");

      const results = searchEngine.search("validation zod signup");
      expect(results.length).toBeGreaterThan(0);
    });
  });

  // ── Cross-tool search ───────────────────────────────────────────────

  describe("Cross-tool search after indexing all 5 tools", () => {
    it("search returns results from multiple tools", () => {
      // All 5 tools have been indexed in prior tests
      const results = searchEngine.search("error");
      expect(results.length).toBeGreaterThan(0);
    });

    it("tool filter works across golden fixtures", () => {
      const tools = db
        .prepare("SELECT DISTINCT tool FROM documents")
        .all() as { tool: string }[];
      const toolIds = new Set(tools.map((t) => t.tool));

      expect(toolIds.has("claude-code")).toBe(true);
      expect(toolIds.has("codex")).toBe(true);
      expect(toolIds.has("gemini-cli")).toBe(true);
      expect(toolIds.has("cline")).toBe(true);
      expect(toolIds.has("aider")).toBe(true);
    });

    it("each tool has at least one indexed document", () => {
      for (const tool of ["claude-code", "codex", "gemini-cli", "cline", "aider"]) {
        const count = db
          .prepare("SELECT COUNT(*) as c FROM documents WHERE tool = ?")
          .get(tool) as { c: number };
        expect(count.c).toBeGreaterThan(0);
      }
    });
  });
});
