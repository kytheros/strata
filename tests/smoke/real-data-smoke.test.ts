/**
 * Real Data Smoke Test
 *
 * This test runs against ACTUAL conversation history on the current machine.
 * It validates the full pipeline end-to-end with real data, not fixtures.
 *
 * What it proves:
 * - Parsers can detect and discover real session files
 * - Real session files parse without crashing
 * - Indexing real data into SQLite works
 * - Search returns meaningful results from real conversations
 * - The CLI works against real data
 *
 * This test is SKIPPED in CI (no conversation history there).
 * Run it locally with: npx vitest run tests/smoke/real-data-smoke.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import { join } from "path";
import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import { SqliteSummaryStore } from "../../src/storage/sqlite-summary-store.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import { ParserRegistry } from "../../src/parsers/parser-registry.js";
import { ClaudeCodeParser } from "../../src/parsers/claude-code-parser.js";
import { CodexParser } from "../../src/parsers/codex-parser.js";
import { ClineParser } from "../../src/parsers/cline-parser.js";
import { GeminiParser } from "../../src/parsers/gemini-parser.js";
import { AiderParser } from "../../src/parsers/aider-parser.js";
import { Sanitizer } from "../../src/sanitizer/sanitizer.js";
import { handleSearchHistory } from "../../src/tools/search-history.js";
import { handleFindSolutions } from "../../src/tools/find-solutions.js";
import { handleListProjects } from "../../src/tools/list-projects.js";

// ── Setup ────────────────────────────────────────────────────────────────

const registry = new ParserRegistry();
registry.register(new ClaudeCodeParser());
registry.register(new CodexParser());
registry.register(new ClineParser());
registry.register(new GeminiParser());
registry.register(new AiderParser());

const detected = registry.detectAvailable();
const detectedIds = detected.map((p) => p.id);

// Skip the entire suite if no tool data exists (e.g., CI)
const hasAnyData = detected.length > 0;

describe.skipIf(!hasAnyData)("Real Data Smoke Test", () => {
  let db: Database.Database;
  let docStore: SqliteDocumentStore;
  let searchEngine: SqliteSearchEngine;
  let knowledgeStore: SqliteKnowledgeStore;
  let summaryStore: SqliteSummaryStore;
  let sanitizer: Sanitizer;
  let tmpDbDir: string;

  let totalSessions = 0;
  let totalChunks = 0;
  let parseErrors = 0;
  const toolSessionCounts: Record<string, number> = {};

  beforeAll(() => {
    tmpDbDir = join(tmpdir(), `strata-smoke-${Date.now()}`);
    mkdirSync(tmpDbDir, { recursive: true });

    const dbPath = join(tmpDbDir, "smoke.db");
    db = openDatabase(dbPath);
    docStore = new SqliteDocumentStore(db);
    searchEngine = new SqliteSearchEngine(docStore);
    knowledgeStore = new SqliteKnowledgeStore(db);
    summaryStore = new SqliteSummaryStore(db);
    sanitizer = new Sanitizer();

    // Index real data from all detected parsers
    const insertBatch = db.transaction(() => {
      for (const parser of detected) {
        const files = parser.discover();
        let parserSessions = 0;

        for (const file of files) {
          try {
            const session = parser.parse(file);
            if (!session) continue;

            // Chunk and index (simplified — one chunk per session for speed)
            const allText = session.messages.map((m) => m.text).join("\n");
            const sanitized = sanitizer.sanitize(allText);
            const toolNames = [...new Set(session.messages.flatMap((m) => m.toolNames))];
            const tokenCount = sanitized.split(/\s+/).length;

            docStore.add(sanitized, tokenCount, {
              sessionId: session.sessionId,
              project: session.project,
              role: "mixed",
              timestamp: session.endTime || Date.now(),
              toolNames,
              messageIndex: 0,
            }, session.tool || parser.id);

            parserSessions++;
            totalSessions++;
            totalChunks++;
          } catch {
            parseErrors++;
          }
        }

        toolSessionCounts[parser.id] = parserSessions;
      }
    });

    insertBatch();
  }, 120000); // 2 min timeout for indexing real data

  afterAll(() => {
    db.close();
    try {
      rmSync(tmpDbDir, { recursive: true, force: true });
    } catch { /* */ }
  });

  // ── 1. Detection ───────────────────────────────────────────────────

  it("at least one parser detects data on this machine", () => {
    expect(detected.length).toBeGreaterThan(0);
    console.log(`  Detected parsers: ${detectedIds.join(", ")}`);
  });

  // ── 2. Discovery + Parsing ─────────────────────────────────────────

  it("discovered and indexed real sessions without excessive errors", () => {
    console.log(`  Total sessions indexed: ${totalSessions}`);
    console.log(`  Parse errors: ${parseErrors}`);
    for (const [tool, count] of Object.entries(toolSessionCounts)) {
      console.log(`    ${tool}: ${count} sessions`);
    }

    expect(totalSessions).toBeGreaterThan(0);
    // Parse error rate should be under 5%
    const totalFiles = detected.reduce((sum, p) => sum + p.discover().length, 0);
    if (totalFiles > 0) {
      const errorRate = parseErrors / totalFiles;
      expect(errorRate).toBeLessThan(0.05);
    }
  });

  // ── 3. Database integrity ──────────────────────────────────────────

  it("database has correct structure and data", () => {
    const docCount = docStore.getDocumentCount();
    expect(docCount).toBe(totalChunks);

    const sessionIds = docStore.getSessionIds();
    expect(sessionIds.size).toBe(totalSessions);

    const projects = docStore.getProjects();
    expect(projects.size).toBeGreaterThan(0);
    console.log(`  Unique projects: ${projects.size}`);
  });

  it("all indexed documents have valid tool labels", () => {
    const tools = db
      .prepare("SELECT DISTINCT tool FROM documents")
      .all() as { tool: string }[];
    const toolIds = tools.map((t) => t.tool);

    // Every tool label must be a known parser ID
    const knownIds = new Set(["claude-code", "codex", "cline", "gemini-cli", "aider"]);
    for (const tool of toolIds) {
      expect(knownIds.has(tool)).toBe(true);
    }
    console.log(`  Tools in index: ${toolIds.join(", ")}`);
  });

  // ── 4. Search works on real data ───────────────────────────────────

  it("keyword search returns results", () => {
    const results = searchEngine.search("error");
    expect(results.length).toBeGreaterThan(0);
    // Results should have non-empty text
    for (const r of results) {
      expect(r.text.length).toBeGreaterThan(0);
      expect(r.sessionId).toBeTruthy();
    }
  });

  it("search with project filter returns only matching projects", () => {
    // Get a project that actually has searchable content
    const projectRows = db
      .prepare("SELECT DISTINCT project FROM documents LIMIT 5")
      .all() as { project: string }[];
    if (projectRows.length === 0) return;

    const targetProject = projectRows[0].project;
    const results = searchEngine.search("test", { project: targetProject });
    // Project filter uses substring matching (`.includes()`), so results
    // should all contain the target project name
    for (const r of results) {
      expect(r.project.toLowerCase()).toContain(targetProject.toLowerCase());
    }
  });

  it("searchSolutions returns results for common errors", () => {
    const results = searchEngine.searchSolutions("error");
    // May or may not have results depending on data, but shouldn't crash
    expect(Array.isArray(results)).toBe(true);
  });

  // ── 5. MCP tool handlers work with real data ───────────────────────

  it("search_history tool returns formatted output", () => {
    const result = handleSearchHistory(searchEngine, { query: "docker" });
    expect(typeof result).toBe("string");
    // Should either have results or a "no results" message
    expect(result.length).toBeGreaterThan(0);
  });

  it("find_solutions tool returns formatted output", () => {
    const result = handleFindSolutions(searchEngine, {
      error_or_problem: "TypeScript compilation",
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  // ── 6. Sanitizer didn't let secrets through ────────────────────────

  it("no obvious API keys in indexed text", () => {
    // Sample check: scan a portion of indexed documents for secret patterns
    const sampleDocs = db
      .prepare("SELECT text FROM documents ORDER BY RANDOM() LIMIT 100")
      .all() as { text: string }[];

    const secretPatterns = [
      /sk-ant-[a-zA-Z0-9]{20,}/,      // Anthropic
      /ghp_[a-zA-Z0-9]{36}/,           // GitHub
      /AKIA[0-9A-Z]{16}/,              // AWS
      /-----BEGIN [A-Z]*PRIVATE KEY-----[\s\\n][A-Za-z0-9+/=\s\\n]{40,}/,  // PEM keys with actual base64 content
    ];

    for (const doc of sampleDocs) {
      for (const pattern of secretPatterns) {
        expect(doc.text).not.toMatch(pattern);
      }
    }
  });

  // ── 7. Per-parser tests (conditional) ──────────────────────────────

  it.skipIf(!detectedIds.includes("claude-code"))(
    "Claude Code: sessions parse with expected fields",
    () => {
      const parser = detected.find((p) => p.id === "claude-code")!;
      const files = parser.discover();
      expect(files.length).toBeGreaterThan(0);

      // Parse a sample of sessions
      const sample = files.slice(0, 5);
      let parsedCount = 0;
      for (const file of sample) {
        const session = parser.parse(file);
        if (!session) continue; // Empty sessions are OK
        expect(session.tool).toBe("claude-code");
        expect(session.sessionId).toBeTruthy();
        expect(session.messages.length).toBeGreaterThan(0);
        // Every message should have a role
        for (const msg of session.messages) {
          expect(["user", "assistant"]).toContain(msg.role);
          // Some messages may have empty text (tool-only), that's valid
        }
        parsedCount++;
      }
      // At least one session should have parsed successfully
      expect(parsedCount).toBeGreaterThan(0);
    }
  );

  it.skipIf(!detectedIds.includes("codex"))(
    "Codex CLI: sessions parse with expected fields",
    () => {
      const parser = detected.find((p) => p.id === "codex")!;
      const files = parser.discover();
      expect(files.length).toBeGreaterThan(0);

      const sample = files.slice(0, 5);
      for (const file of sample) {
        const session = parser.parse(file);
        if (!session) continue;
        expect(session.tool).toBe("codex");
        expect(session.sessionId).toBeTruthy();
        expect(session.messages.length).toBeGreaterThan(0);
      }
    }
  );

  it.skipIf(!detectedIds.includes("cline"))(
    "Cline: sessions parse with expected fields",
    () => {
      const parser = detected.find((p) => p.id === "cline")!;
      const files = parser.discover();
      expect(files.length).toBeGreaterThan(0);

      const sample = files.slice(0, 5);
      for (const file of sample) {
        const session = parser.parse(file);
        if (!session) continue;
        expect(session.tool).toBe("cline");
        expect(session.messages.length).toBeGreaterThan(0);
      }
    }
  );

  it.skipIf(!detectedIds.includes("gemini-cli"))(
    "Gemini CLI: sessions parse with expected fields",
    () => {
      const parser = detected.find((p) => p.id === "gemini-cli")!;
      const files = parser.discover();
      expect(files.length).toBeGreaterThan(0);

      const sample = files.slice(0, 5);
      for (const file of sample) {
        const session = parser.parse(file);
        if (!session) continue;
        expect(session.tool).toBe("gemini-cli");
        expect(session.messages.length).toBeGreaterThan(0);
      }
    }
  );

  it.skipIf(!detectedIds.includes("aider"))(
    "Aider: sessions parse with expected fields",
    () => {
      const parser = detected.find((p) => p.id === "aider")!;
      const files = parser.discover();
      expect(files.length).toBeGreaterThan(0);

      const sample = files.slice(0, 5);
      for (const file of sample) {
        const session = parser.parse(file);
        if (!session) continue;
        expect(session.tool).toBe("aider");
        expect(session.messages.length).toBeGreaterThan(0);
      }
    }
  );
});

// ── CLI Smoke Test ──────────────────────────────────────────────────────

describe.skipIf(!hasAnyData)("CLI Smoke Test (real data)", () => {
  const cliPath = join(__dirname, "..", "..", "src", "cli.ts");
  const run = (args: string, timeout = 60000) =>
    execSync(`npx tsx "${cliPath}" ${args}`, {
      cwd: join(__dirname, "..", ".."),
      timeout,
      encoding: "utf-8",
    });

  it("--version matches package.json", () => {
    const output = run("--version").trim();
    const pkg = require("../../package.json");
    expect(output).toBe(pkg.version);
  });

  it("status command completes and shows parser info", () => {
    // status uses the real data dir and prints parser names (human-readable)
    const output = run("status", 60000);
    expect(output).toContain("Strata");
    // CLI prints "Claude Code (detected)" not "claude-code"
    expect(
      output.includes("Claude Code") ||
      output.includes("Codex") ||
      output.includes("Cline") ||
      output.includes("Gemini") ||
      output.includes("Aider")
    ).toBe(true);
  });

  it("search command works against existing index", () => {
    // Use the real data dir (not a fresh one) so we don't rebuild the index
    try {
      const output = run('search "error" --limit 5', 60000);
      expect(typeof output).toBe("string");
    } catch (err: unknown) {
      // Exit code 1 = no results, which is acceptable
      const error = err as { status?: number };
      if (error.status !== 1) {
        throw err; // Re-throw unexpected errors
      }
    }
  });
});
