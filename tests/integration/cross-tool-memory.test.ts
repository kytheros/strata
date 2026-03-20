/**
 * Cross-tool memory integration tests.
 *
 * Validates that the shared SQLite database works correctly across tool boundaries:
 * - Memory stored via store_memory is searchable regardless of originating tool
 * - Gemini CLI sessions are indexed alongside Claude Code sessions
 * - search_history returns results from both Gemini and Claude sessions
 * - Tool attribution is correct (gemini-cli vs claude-code)
 * - Tool filtering isolates sessions by tool
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import { ClaudeCodeParser } from "../../src/parsers/claude-code-parser.js";
import { GeminiParser } from "../../src/parsers/gemini-parser.js";
import type { ParsedSession } from "../../src/parsers/session-parser.js";

// ── Fixture Builders ──────────────────────────────────────────────────

function createClaudeFixture(baseDir: string): string {
  const projectsDir = join(baseDir, "claude-projects");
  const projectSubDir = join(projectsDir, "my-project");
  mkdirSync(projectSubDir, { recursive: true });
  const sessionFile = join(projectSubDir, "session-claude1.jsonl");

  const lines = [
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "How do I configure ESLint for TypeScript?" },
      uuid: "cc-u1",
      timestamp: "2026-03-10T09:00:00Z",
      cwd: "/home/user/my-project",
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Install eslint and typescript-eslint, then create an eslint.config.ts with the recommended flat config.",
          },
        ],
      },
      uuid: "cc-u2",
      timestamp: "2026-03-10T09:01:00Z",
      cwd: "/home/user/my-project",
    }),
  ];
  writeFileSync(sessionFile, lines.join("\n") + "\n");
  return projectsDir;
}

function createGeminiFixture(baseDir: string): string {
  const geminiDir = join(baseDir, "gemini-data");
  const projectHash = "gemini-crosstest";
  const chatsDir = join(geminiDir, projectHash, "chats");
  mkdirSync(chatsDir, { recursive: true });

  const checkpoint = [
    {
      role: "user",
      parts: [{ text: "Set up Vitest for testing a TypeScript library" }],
    },
    {
      role: "model",
      parts: [
        {
          text: "Install vitest and configure it in vitest.config.ts. Use the defineConfig helper for type safety.",
        },
      ],
    },
  ];
  writeFileSync(
    join(chatsDir, "checkpoint-crosstest.json"),
    JSON.stringify(checkpoint)
  );
  return geminiDir;
}

/** Index a parsed session into the document store */
async function indexSession(
  store: SqliteDocumentStore,
  session: ParsedSession,
  parserId: string
): Promise<void> {
  const tool = session.tool || parserId;
  const allText = session.messages.map((m) => m.text).join("\n");
  const toolNames = [
    ...new Set(session.messages.flatMap((m) => m.toolNames)),
  ];
  const tokenCount = allText.split(/\s+/).length;

  await store.add(
    allText,
    tokenCount,
    {
      sessionId: session.sessionId,
      project: session.project,
      role: "mixed",
      timestamp: session.endTime || Date.now(),
      toolNames,
      messageIndex: 0,
    },
    tool
  );
}

// ── Test Suite ─────────────────────────────────────────────────────────

describe("Cross-tool memory", () => {
  let tmpDir: string;
  let db: Database.Database;
  let docStore: SqliteDocumentStore;
  let searchEngine: SqliteSearchEngine;
  let knowledgeStore: SqliteKnowledgeStore;

  beforeAll(async () => {
    tmpDir = join(tmpdir(), `cross-tool-memory-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    // Create fixtures
    const claudeDir = createClaudeFixture(tmpDir);
    const geminiDir = createGeminiFixture(tmpDir);

    // Set up in-memory SQLite database
    db = openDatabase(":memory:");
    docStore = new SqliteDocumentStore(db);
    searchEngine = new SqliteSearchEngine(docStore);
    knowledgeStore = new SqliteKnowledgeStore(db);

    // Parse and index Claude Code sessions
    const claudeParser = new ClaudeCodeParser(claudeDir);
    expect(claudeParser.detect()).toBe(true);
    const claudeFiles = claudeParser.discover();
    for (const file of claudeFiles) {
      const session = claudeParser.parse(file);
      if (session) await indexSession(docStore, session, claudeParser.id);
    }

    // Parse and index Gemini CLI sessions
    const geminiParser = new GeminiParser(geminiDir);
    expect(geminiParser.detect()).toBe(true);
    const geminiFiles = geminiParser.discover();
    for (const file of geminiFiles) {
      const session = geminiParser.parse(file);
      if (session) await indexSession(docStore, session, geminiParser.id);
    }

    // Store a knowledge entry (simulates store_memory from either tool)
    await knowledgeStore.addEntry({
      id: "mem-cross-1",
      type: "decision",
      project: "global",
      sessionId: "manual",
      timestamp: Date.now(),
      summary: "Use flat config for ESLint in all projects",
      details: "Decided to standardize on the new ESLint flat config format.",
      tags: ["eslint", "config"],
      relatedFiles: [],
    });
  });

  afterAll(() => {
    db.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Cleanup best effort
    }
  });

  // ── Both tools indexed ──────────────────────────────────────────────

  it("indexes both Claude Code and Gemini CLI sessions", async () => {
    const tools = (
      db
        .prepare("SELECT DISTINCT tool FROM documents")
        .all() as { tool: string }[]
    )
      .map((r) => r.tool)
      .sort();

    expect(tools).toContain("claude-code");
    expect(tools).toContain("gemini-cli");
  });

  // ── Tool attribution ───────────────────────────────────────────────

  it("tool attribution is correct (gemini-cli vs claude-code)", async () => {
    const claudeDocs = db
      .prepare("SELECT * FROM documents WHERE tool = ?")
      .all("claude-code") as { text: string }[];

    const geminiDocs = db
      .prepare("SELECT * FROM documents WHERE tool = ?")
      .all("gemini-cli") as { text: string }[];

    expect(claudeDocs.length).toBeGreaterThan(0);
    expect(geminiDocs.length).toBeGreaterThan(0);

    // Claude session should contain ESLint content
    expect(
      claudeDocs.some((d) => d.text.toLowerCase().includes("eslint"))
    ).toBe(true);

    // Gemini session should contain Vitest content
    expect(
      geminiDocs.some((d) => d.text.toLowerCase().includes("vitest"))
    ).toBe(true);
  });

  // ── Cross-tool search ──────────────────────────────────────────────

  it("search_history returns Claude Code results", async () => {
    const results = await searchEngine.search("ESLint TypeScript");
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.some((r) => r.text.toLowerCase().includes("eslint"))
    ).toBe(true);
  });

  it("search_history returns Gemini CLI results", async () => {
    const results = await searchEngine.search("Vitest testing");
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.some((r) => r.text.toLowerCase().includes("vitest"))
    ).toBe(true);
  });

  it("search_history returns both Gemini and Claude results for broad query", async () => {
    // Both sessions involve TypeScript — broad query should find both
    const results = await searchEngine.search("TypeScript config");
    expect(results.length).toBeGreaterThanOrEqual(2);

    // Verify results come from different tools
    const sessionIds = results.map((r) => r.sessionId);
    const toolsInResults = new Set<string>();
    for (const sid of sessionIds) {
      const doc = db
        .prepare("SELECT tool FROM documents WHERE session_id = ?")
        .get(sid) as { tool: string } | undefined;
      if (doc) toolsInResults.add(doc.tool);
    }

    expect(toolsInResults.size).toBeGreaterThanOrEqual(2);
  });

  // ── Tool filtering ─────────────────────────────────────────────────

  it("tool: filter correctly isolates Gemini sessions", async () => {
    const results = await searchEngine.search("tool:gemini-cli TypeScript");

    for (const r of results) {
      const doc = db
        .prepare("SELECT tool FROM documents WHERE session_id = ?")
        .get(r.sessionId) as { tool: string } | undefined;
      if (doc) {
        expect(doc.tool).toBe("gemini-cli");
      }
    }
  });

  it("tool: filter correctly isolates Claude sessions", async () => {
    const results = await searchEngine.search("tool:claude-code TypeScript");

    for (const r of results) {
      const doc = db
        .prepare("SELECT tool FROM documents WHERE session_id = ?")
        .get(r.sessionId) as { tool: string } | undefined;
      if (doc) {
        expect(doc.tool).toBe("claude-code");
      }
    }
  });

  // ── Knowledge store is tool-agnostic ───────────────────────────────

  it("memory stored via store_memory is searchable regardless of tool", async () => {
    // The knowledge entry we stored manually should be findable
    const results = await knowledgeStore.search("ESLint flat config");
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.some((r) => r.summary.includes("flat config"))
    ).toBe(true);
  });

  it("knowledge entries from different tools coexist", async () => {
    // Store knowledge entries attributed to different sessions/tools
    await knowledgeStore.addEntry({
      id: "mem-claude-1",
      type: "solution",
      project: "my-project",
      sessionId: "session-claude1",
      timestamp: Date.now(),
      summary: "Fixed ESLint config import resolution",
      details: "Changed module resolution to bundler in tsconfig.",
      tags: ["eslint"],
      relatedFiles: [],
    });

    await knowledgeStore.addEntry({
      id: "mem-gemini-1",
      type: "solution",
      project: "my-project",
      sessionId: "gemini-crosstest-crosstest",
      timestamp: Date.now(),
      summary: "Fixed Vitest timeout by setting testTimeout in config",
      details: "Added testTimeout: 10000 to vitest.config.ts.",
      tags: ["vitest"],
      relatedFiles: [],
    });

    // Both should be searchable
    const eslintResults = await knowledgeStore.search("ESLint config import");
    expect(eslintResults.length).toBeGreaterThan(0);

    const vitestResults = await knowledgeStore.search("Vitest timeout");
    expect(vitestResults.length).toBeGreaterThan(0);
  });

  // ── find_solutions works across tools ──────────────────────────────

  it("searchSolutions finds solutions across tools", async () => {
    const results = await searchEngine.searchSolutions("TypeScript configuration");
    expect(results.length).toBeGreaterThan(0);
  });
});
