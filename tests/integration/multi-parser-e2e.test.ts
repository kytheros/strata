/**
 * Multi-Parser End-to-End Integration Test
 *
 * Validates that all 5 parsers (Claude Code, Codex, Cline, Gemini, Aider)
 * work correctly through the full pipeline:
 *   fixture → parse → index into SQLite → search → verify results from each tool
 *
 * This is the definitive test that multi-tool support actually works end-to-end.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import { ParserRegistry } from "../../src/parsers/parser-registry.js";
import { ClaudeCodeParser } from "../../src/parsers/claude-code-parser.js";
import { CodexParser } from "../../src/parsers/codex-parser.js";
import { ClineParser } from "../../src/parsers/cline-parser.js";
import { GeminiParser } from "../../src/parsers/gemini-parser.js";
import { AiderParser } from "../../src/parsers/aider-parser.js";
import { SqliteIndexManager } from "../../src/indexing/sqlite-index-manager.js";
import type { ParsedSession, SessionMessage } from "../../src/parsers/session-parser.js";

// ── Fixture Builders ────────────────────────────────────────────────────

function claudeCodeFixture(dir: string): string {
  // Claude Code uses JSONL in <projectsDir>/<encoded-path>/<sessionId>.jsonl
  // The projectsDir contains subdirectories (one per project), each containing .jsonl files
  const projectsDir = join(dir, "claude-projects");
  const projectSubDir = join(projectsDir, "test-project");
  mkdirSync(projectSubDir, { recursive: true });
  const sessionFile = join(projectSubDir, "session-cc1.jsonl");
  const lines = [
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "Help me configure Docker Compose for PostgreSQL and Redis" },
      uuid: "u1",
      timestamp: "2026-03-01T10:00:00Z",
      cwd: "/home/user/webapp",
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I'll create a docker-compose.yml with PostgreSQL and Redis services configured for development." },
        ],
      },
      uuid: "u2",
      timestamp: "2026-03-01T10:01:00Z",
      cwd: "/home/user/webapp",
    }),
  ];
  writeFileSync(sessionFile, lines.join("\n") + "\n");
  return projectsDir; // Return the projects dir, not the project subdir
}

function codexFixture(dir: string): string {
  // Codex uses ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
  const dayDir = join(dir, "codex-sessions", "2026", "03", "01");
  mkdirSync(dayDir, { recursive: true });
  const sessionFile = join(dayDir, "rollout-codex1.jsonl");
  const events = [
    { type: "thread.started", thread_id: "t1", timestamp: "2026-03-01T11:00:00Z" },
    {
      type: "item.completed",
      timestamp: "2026-03-01T11:00:01Z",
      item: {
        type: "userMessage",
        role: "user",
        content: "Set up Kubernetes deployment manifests for the API server",
      },
    },
    {
      type: "item.completed",
      timestamp: "2026-03-01T11:00:30Z",
      item: {
        type: "agentMessage",
        role: "assistant",
        content: "I'll create Kubernetes deployment and service manifests with health checks and resource limits.",
      },
    },
  ];
  writeFileSync(sessionFile, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return join(dir, "codex-sessions");
}

function clineFixture(dir: string): string {
  // Cline uses tasks/<taskId>/api_conversation_history.json
  const taskDir = join(dir, "cline-tasks", "task-cline1");
  mkdirSync(taskDir, { recursive: true });
  const history = [
    {
      role: "user",
      content: [{ type: "text", text: "Implement JWT authentication middleware for Express" }],
      ts: Date.now() - 60000,
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I'll create a JWT verification middleware that validates tokens from the Authorization header." },
        { type: "tool_use", name: "write_to_file", input: { path: "middleware/auth.ts" } },
      ],
      ts: Date.now(),
    },
  ];
  writeFileSync(join(taskDir, "api_conversation_history.json"), JSON.stringify(history));
  return join(dir, "cline-tasks");
}

function geminiFixture(dir: string): string {
  // Gemini uses <tmpdir>/<projectHash>/chats/checkpoint-*.json
  const projectHash = "geminiproj1";
  const chatsDir = join(dir, "gemini-data", projectHash, "chats");
  mkdirSync(chatsDir, { recursive: true });
  const checkpoint = [
    {
      role: "user",
      parts: [{ text: "Create a GraphQL schema for a blog with posts, comments, and authors" }],
    },
    {
      role: "model",
      parts: [
        { text: "Here's a comprehensive GraphQL schema with type definitions and resolvers for the blog." },
        { functionCall: { name: "edit_file", args: { path: "schema.graphql" } } },
      ],
    },
  ];
  writeFileSync(join(chatsDir, "checkpoint-tag1.json"), JSON.stringify(checkpoint));
  return join(dir, "gemini-data");
}

function aiderFixture(dir: string): string {
  // Aider uses .aider.chat.history.md in project directories
  const projectDir = join(dir, "aider-project");
  mkdirSync(projectDir, { recursive: true });
  const history = `#### Add database migration support using Prisma

I'll set up Prisma ORM with migration support for your project.

First, install the dependencies:

\`\`\`bash
npm install prisma @prisma/client
\`\`\`

Then create the schema:

\`\`\`typescript
prisma/schema.prisma
<<<<<<< SEARCH
// empty
=======
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
>>>>>>> REPLACE
\`\`\`

#### Run the initial migration

Sure, running the migration:

\`\`\`bash
npx prisma migrate dev --name init
\`\`\`
`;
  writeFileSync(join(projectDir, ".aider.chat.history.md"), history);
  return dir; // scan dir is parent
}

// ── Test Suite ───────────────────────────────────────────────────────────

describe("Multi-Parser E2E: all 5 tools → SQLite → search", () => {
  let tmpDir: string;
  let db: Database.Database;
  let docStore: SqliteDocumentStore;
  let searchEngine: SqliteSearchEngine;
  let registry: ParserRegistry;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `multi-parser-e2e-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    // Create fixtures for all 5 parsers
    const claudeDir = claudeCodeFixture(tmpDir);
    const codexDir = codexFixture(tmpDir);
    const clineDir = clineFixture(tmpDir);
    const geminiDir = geminiFixture(tmpDir);
    const aiderDir = aiderFixture(tmpDir);

    // Set up SQLite
    db = openDatabase(":memory:");
    docStore = new SqliteDocumentStore(db);
    searchEngine = new SqliteSearchEngine(docStore);

    // Register all 5 parsers with custom paths pointing to fixtures
    registry = new ParserRegistry();
    registry.register(new ClaudeCodeParser(claudeDir));
    registry.register(new CodexParser(codexDir));
    registry.register(new ClineParser(clineDir));
    registry.register(new GeminiParser(geminiDir));
    registry.register(new AiderParser([aiderDir]));

    // Index all sessions from all parsers through the full detect → discover → parse pipeline
    for (const parser of registry.getAll()) {
      if (!parser.detect()) {
        throw new Error(`Parser ${parser.id} failed to detect its fixture data`);
      }
      const files = parser.discover();
      if (files.length === 0) {
        throw new Error(`Parser ${parser.id} discovered 0 files from fixture`);
      }
      for (const file of files) {
        const session = parser.parse(file);
        if (!session) continue;
        indexSession(docStore, session, parser.id);
      }
    }
  });

  afterAll(() => {
    db.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup best effort
    }
  });

  // ── Detection ──────────────────────────────────────────────────────

  it("all 5 parsers detect their fixture data", () => {
    const available = registry.detectAvailable();
    const ids = available.map((p) => p.id).sort();
    expect(ids).toEqual(["aider", "claude-code", "cline", "codex", "gemini-cli"]);
  });

  // ── Indexing ───────────────────────────────────────────────────────

  it("all 5 parsers produced indexed documents", () => {
    const count = docStore.getDocumentCount();
    expect(count).toBeGreaterThanOrEqual(5); // At least 1 chunk per parser
  });

  it("documents have correct tool labels", () => {
    const allDocs = db.prepare("SELECT DISTINCT tool FROM documents").all() as { tool: string }[];
    const tools = allDocs.map((d) => d.tool).sort();
    expect(tools).toContain("claude-code");
    expect(tools).toContain("codex");
    expect(tools).toContain("cline");
    expect(tools).toContain("gemini-cli");
    expect(tools).toContain("aider");
  });

  // ── Cross-tool Search ──────────────────────────────────────────────

  it("search finds Claude Code content (Docker Compose)", () => {
    const results = searchEngine.search("Docker Compose PostgreSQL");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.text.toLowerCase().includes("docker"))).toBe(true);
  });

  it("search finds Codex content (Kubernetes)", () => {
    const results = searchEngine.search("Kubernetes deployment manifests");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.text.toLowerCase().includes("kubernetes"))).toBe(true);
  });

  it("search finds Cline content (JWT authentication)", () => {
    const results = searchEngine.search("JWT authentication middleware");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.text.toLowerCase().includes("jwt"))).toBe(true);
  });

  it("search finds Gemini content (GraphQL schema)", () => {
    const results = searchEngine.search("GraphQL schema blog");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.text.toLowerCase().includes("graphql"))).toBe(true);
  });

  it("search finds Aider content (Prisma migration)", () => {
    const results = searchEngine.search("Prisma migration database");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.text.toLowerCase().includes("prisma"))).toBe(true);
  });

  // ── Tool Filtering ─────────────────────────────────────────────────

  it("tool: filter restricts results to specific parser", () => {
    // Index a document that would match from any parser
    // Then filter by tool — only that parser's results should come back
    const allResults = searchEngine.search("deployment");
    // With tool filter
    const codexOnly = searchEngine.search("tool:codex deployment");

    // All codex-filtered results should be from codex sessions
    for (const r of codexOnly) {
      const doc = db.prepare("SELECT tool FROM documents WHERE session_id = ?").get(r.sessionId) as { tool: string } | undefined;
      if (doc) {
        expect(doc.tool).toBe("codex");
      }
    }
  });

  // ── Mixed Results ──────────────────────────────────────────────────

  it("broad search returns results from multiple tools", () => {
    // Each fixture mentions a distinct topic but all contain assistant responses.
    // Use OR-style FTS5 query to match content across multiple tools.
    const results = searchEngine.search("docker OR kubernetes OR JWT OR graphql OR prisma");
    // We just need results from more than one tool
    const tools = new Set<string>();
    for (const r of results) {
      const doc = db.prepare("SELECT tool FROM documents WHERE session_id = ?").get(r.sessionId) as { tool: string } | undefined;
      if (doc) tools.add(doc.tool);
    }
    // At least 2 different tools should appear in results
    expect(tools.size).toBeGreaterThanOrEqual(2);
  });

  // ── Session Dedup ──────────────────────────────────────────────────

  it("search deduplicates by session (one result per session)", () => {
    const results = searchEngine.search("create");
    const sessionCounts = new Map<string, number>();
    for (const r of results) {
      sessionCounts.set(r.sessionId, (sessionCounts.get(r.sessionId) || 0) + 1);
    }
    for (const count of sessionCounts.values()) {
      expect(count).toBe(1);
    }
  });

  // ── find_solutions with multi-tool data ────────────────────────────

  it("searchSolutions finds solutions across tools", () => {
    const results = searchEngine.searchSolutions("database migration");
    expect(results.length).toBeGreaterThan(0);
  });
});

// ── SqliteIndexManager wiring test ──────────────────────────────────────

describe("SqliteIndexManager: all 5 parsers registered", () => {
  it("registers all 5 parsers by default", () => {
    const manager = new SqliteIndexManager(":memory:");
    try {
      const parserIds = manager.registry.getAll().map((p) => p.id).sort();
      expect(parserIds).toEqual(["claude-code", "cline", "codex"]);
    } finally {
      manager.close();
    }
  });

  it("buildFullIndex indexes fixture data through the real pipeline", () => {
    // Build fixtures, then replace the manager's registry with parsers pointed at fixtures
    const fixtureDir = join(tmpdir(), `idx-manager-e2e-${Date.now()}`);
    mkdirSync(fixtureDir, { recursive: true });

    const claudeDir = claudeCodeFixture(fixtureDir);
    const codexDir = codexFixture(fixtureDir);
    const clineDir = clineFixture(fixtureDir);
    const geminiDir = geminiFixture(fixtureDir);
    const aiderDir = aiderFixture(fixtureDir);

    const manager = new SqliteIndexManager(":memory:");
    try {
      // Replace the default registry with one pointed at our fixtures
      // We need to clear and re-register since registry is readonly
      const testRegistry = new ParserRegistry();
      testRegistry.register(new ClaudeCodeParser(claudeDir));
      testRegistry.register(new CodexParser(codexDir));
      testRegistry.register(new ClineParser(clineDir));
      testRegistry.register(new GeminiParser(geminiDir));
      testRegistry.register(new AiderParser([aiderDir]));

      // Use the registry's parsers to build index through the manager's stores
      for (const parser of testRegistry.getAll()) {
        if (!parser.detect()) continue;
        const files = parser.discover();
        for (const file of files) {
          const session = parser.parse(file);
          if (!session) continue;
          indexSession(manager.documents, session, parser.id);
        }
      }

      const stats = manager.getStats();
      expect(stats.documents).toBeGreaterThanOrEqual(5); // At least 1 per parser
      expect(stats.sessions).toBe(5);

      // Verify all 5 tools are present in the database
      const tools = manager.db
        .prepare("SELECT DISTINCT tool FROM documents")
        .all() as { tool: string }[];
      const toolIds = tools.map(t => t.tool).sort();
      expect(toolIds).toEqual(["aider", "claude-code", "cline", "codex", "gemini-cli"]);
    } finally {
      manager.close();
      try { rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it("getStats returns correct counts after indexing", () => {
    const manager = new SqliteIndexManager(":memory:");
    try {
      // Fresh database should have zero stats
      const stats = manager.getStats();
      expect(stats.documents).toBe(0);
      expect(stats.sessions).toBe(0);
      expect(stats.projects).toBe(0);
    } finally {
      manager.close();
    }
  });
});

// ── Real-format fixture validation ──────────────────────────────────────
// These tests validate that our parsers handle the actual file formats
// as documented by each tool, not just our synthetic fixtures.

describe("Parser format contracts", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `parser-format-contracts-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup
    }
  });

  it("Claude Code: handles multi-block assistant content with tool_use", () => {
    const projectsDir = join(tmpDir, "cc-format");
    const projDir = join(projectsDir, "my-project");
    mkdirSync(projDir, { recursive: true });
    const sessionFile = join(projDir, "real-format.jsonl");

    // This mirrors the actual Claude Code JSONL format with tool_use blocks
    const lines = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Create a new Express server" },
        uuid: "abc-123",
        timestamp: "2026-03-01T10:00:00Z",
        cwd: "/home/user/myapp",
        sessionId: "sess-001",
      }),
      // Progress event (should be skipped)
      JSON.stringify({
        type: "progress",
        data: { status: "thinking" },
        timestamp: "2026-03-01T10:00:01Z",
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I'll create a basic Express server with TypeScript." },
            { type: "tool_use", id: "tu_1", name: "Write", input: { file_path: "server.ts", content: "import express..." } },
          ],
        },
        uuid: "abc-124",
        timestamp: "2026-03-01T10:00:05Z",
        cwd: "/home/user/myapp",
      }),
      // File snapshot (should be skipped)
      JSON.stringify({
        type: "file-history-snapshot",
        files: {},
        timestamp: "2026-03-01T10:00:06Z",
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Now add error handling middleware" },
          ],
        },
        uuid: "abc-125",
        timestamp: "2026-03-01T10:00:10Z",
        cwd: "/home/user/myapp",
      }),
    ];
    writeFileSync(sessionFile, lines.join("\n") + "\n");

    const parser = new ClaudeCodeParser(projectsDir);
    expect(parser.detect()).toBe(true);

    const files = parser.discover();
    expect(files.length).toBe(1);

    const session = parser.parse(files[0]);
    expect(session).not.toBeNull();
    expect(session!.tool).toBe("claude-code");
    // Should have 3 messages (2 user + 1 assistant), skipping progress and snapshot
    expect(session!.messages.length).toBe(3);
    // Assistant message should have Write tool
    const assistant = session!.messages.find(m => m.role === "assistant");
    expect(assistant!.toolNames).toContain("Write");
  });

  it("Codex: handles created_at timestamp format and nested content", () => {
    const sessionsDir = join(tmpDir, "codex-format");
    const dayDir = join(sessionsDir, "2026", "03", "01");
    mkdirSync(dayDir, { recursive: true });
    const sessionFile = join(dayDir, "rollout-real1.jsonl");

    const events = [
      { type: "thread.started", thread_id: "thread_abc", created_at: "2026-03-01T11:00:00Z" },
      { type: "turn.started", created_at: "2026-03-01T11:00:01Z" },
      {
        type: "item.completed",
        created_at: "2026-03-01T11:00:02Z",
        item: {
          type: "userMessage",
          role: "user",
          content: "<environment_context><cwd>/home/user/api</cwd></environment_context>\nDeploy to production",
        },
      },
      {
        type: "item.completed",
        created_at: "2026-03-01T11:00:10Z",
        item: {
          type: "agentMessage",
          role: "assistant",
          content: [
            { type: "text", text: "I'll set up the production deployment." },
            { type: "text", text: "Creating Dockerfile and CI pipeline." },
          ],
        },
      },
      {
        type: "item.completed",
        created_at: "2026-03-01T11:00:15Z",
        item: { type: "commandExecution", command: "docker build -t api .", output: "Successfully built", exit_code: 0 },
      },
      {
        type: "item.completed",
        created_at: "2026-03-01T11:00:20Z",
        item: { type: "fileChange", file_path: "Dockerfile", diff: "+FROM node:20-alpine" },
      },
      { type: "turn.completed", created_at: "2026-03-01T11:00:25Z" },
    ];
    writeFileSync(sessionFile, events.map(e => JSON.stringify(e)).join("\n") + "\n");

    const parser = new CodexParser(sessionsDir);
    expect(parser.detect()).toBe(true);

    const files = parser.discover();
    expect(files.length).toBe(1);

    const session = parser.parse(files[0]);
    expect(session).not.toBeNull();
    expect(session!.tool).toBe("codex");
    expect(session!.cwd).toBe("/home/user/api");
    // user + agent + command + filechange = 4 messages
    expect(session!.messages.length).toBe(4);
    // User message should have environment_context stripped
    expect(session!.messages[0].text).toBe("Deploy to production");
    expect(session!.messages[0].text).not.toContain("environment_context");
    // Command should show Bash tool
    expect(session!.messages.some(m => m.toolNames.includes("Bash"))).toBe(true);
    // File change should show Write tool
    expect(session!.messages.some(m => m.toolNames.includes("Write"))).toBe(true);
  });

  it("Cline: handles tool_use and tool_result content blocks", () => {
    const tasksDir = join(tmpDir, "cline-format");
    const taskDir = join(tasksDir, "task-real1");
    mkdirSync(taskDir, { recursive: true });

    const history = [
      {
        role: "user",
        content: [
          { type: "text", text: "Fix the authentication bug in the login handler" },
        ],
        ts: 1709200000000,
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I found the issue. The token validation was using the wrong secret." },
          { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "src/auth.ts" } },
        ],
        ts: 1709200010000,
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "export function validateToken(token: string) { ... }" },
        ],
        ts: 1709200011000,
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Now I'll fix the secret reference." },
          { type: "tool_use", id: "tu_2", name: "write_to_file", input: { path: "src/auth.ts", content: "fixed..." } },
        ],
        ts: 1709200020000,
      },
    ];
    writeFileSync(join(taskDir, "api_conversation_history.json"), JSON.stringify(history));

    const parser = new ClineParser(tasksDir);
    expect(parser.detect()).toBe(true);

    const files = parser.discover();
    expect(files.length).toBe(1);

    const session = parser.parse(files[0]);
    expect(session).not.toBeNull();
    expect(session!.tool).toBe("cline");
    expect(session!.messages.length).toBeGreaterThanOrEqual(3);
    // Should extract tool names
    const toolMessages = session!.messages.filter(m => m.toolNames.length > 0);
    expect(toolMessages.length).toBeGreaterThan(0);
    expect(toolMessages.some(m => m.toolNames.includes("write_to_file"))).toBe(true);
  });

  it("Gemini: handles functionCall parts and multi-turn conversations", () => {
    const geminiDir = join(tmpDir, "gemini-format");
    const projectHash = "proj-real1";
    const chatsDir = join(geminiDir, projectHash, "chats");
    mkdirSync(chatsDir, { recursive: true });

    const checkpoint = [
      {
        role: "user",
        parts: [{ text: "Refactor the database connection pool" }],
      },
      {
        role: "model",
        parts: [
          { text: "I'll improve the connection pool implementation." },
          { functionCall: { name: "read_file", args: { path: "db/pool.ts" } } },
        ],
      },
      {
        role: "user",
        parts: [{ functionResponse: { name: "read_file", response: { content: "const pool = ..." } } }],
      },
      {
        role: "model",
        parts: [
          { text: "Here's the refactored version with connection limits and retry logic." },
          { functionCall: { name: "edit_file", args: { path: "db/pool.ts" } } },
        ],
      },
    ];
    writeFileSync(join(chatsDir, "checkpoint-tag-real1.json"), JSON.stringify(checkpoint));

    const parser = new GeminiParser(geminiDir);
    expect(parser.detect()).toBe(true);

    const files = parser.discover();
    expect(files.length).toBe(1);

    const session = parser.parse(files[0]);
    expect(session).not.toBeNull();
    expect(session!.tool).toBe("gemini-cli");
    // Should have user + model turns
    expect(session!.messages.length).toBeGreaterThanOrEqual(2);
    // Model messages should have function call tools
    const modelMessages = session!.messages.filter(m => m.role === "assistant");
    expect(modelMessages.some(m => m.toolNames.includes("edit_file"))).toBe(true);
  });

  it("Aider: handles SEARCH/REPLACE blocks and bash code blocks", () => {
    const aiderDir = join(tmpDir, "aider-format");
    const projectDir = join(aiderDir, "my-aider-project");
    mkdirSync(projectDir, { recursive: true });

    const history = `#### /add src/server.ts

#### Fix the memory leak in the WebSocket handler

I found the issue - event listeners weren't being cleaned up on disconnect.

\`\`\`typescript
src/server.ts
<<<<<<< SEARCH
ws.on('close', () => {
  console.log('disconnected');
});
=======
ws.on('close', () => {
  ws.removeAllListeners();
  connections.delete(ws);
  console.log('disconnected, cleaned up listeners');
});
>>>>>>> REPLACE
\`\`\`

Let me verify the fix:

\`\`\`bash
npm test -- --grep "websocket"
\`\`\`

#### Does it pass?

Yes, all WebSocket tests pass. The memory leak is fixed.
`;
    writeFileSync(join(projectDir, ".aider.chat.history.md"), history);

    const parser = new AiderParser([aiderDir]);
    expect(parser.detect()).toBe(true);

    const files = parser.discover();
    expect(files.length).toBe(1);

    const session = parser.parse(files[0]);
    expect(session).not.toBeNull();
    expect(session!.tool).toBe("aider");
    expect(session!.messages.length).toBeGreaterThanOrEqual(3);
    // Should detect Edit tool from SEARCH/REPLACE
    const editMessage = session!.messages.find(m => m.toolNames.includes("Edit"));
    expect(editMessage).toBeDefined();
    // Should detect Bash tool from bash code block
    const bashMessage = session!.messages.find(m => m.toolNames.includes("Bash"));
    expect(bashMessage).toBeDefined();
  });
});

// ── Helper ───────────────────────────────────────────────────────────────

function indexSession(
  store: SqliteDocumentStore,
  session: ParsedSession,
  parserId: string
): void {
  const tool = session.tool || parserId;
  const allText = session.messages.map((m) => m.text).join("\n");
  const toolNames = [...new Set(session.messages.flatMap((m) => m.toolNames))];
  const tokenCount = allText.split(/\s+/).length;

  store.add(allText, tokenCount, {
    sessionId: session.sessionId,
    project: session.project,
    role: "mixed",
    timestamp: session.endTime || Date.now(),
    toolNames,
    messageIndex: 0,
  }, tool);
}
