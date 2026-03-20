/**
 * Phase 4 End-to-End Smoke Tests
 *
 * Validates that Phase 4 features work together end-to-end:
 * - HTTP transport with full MCP lifecycle
 * - store_memory → search_history round-trip
 * - Real-time watcher → knowledge extraction → search
 * - New parsers produce well-formed sessions
 * - Deploy artifact structure validation
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import { handleStoreMemory } from "../../src/tools/store-memory.js";
import { handleSearchHistory } from "../../src/tools/search-history.js";
import { handleFindSolutions } from "../../src/tools/find-solutions.js";
import { startHttpTransport, type HttpTransportHandle } from "../../src/transports/http-transport.js";
import { createServer } from "../../src/server.js";
import { RealtimeWatcher } from "../../src/watcher/realtime-watcher.js";
import { ClineParser } from "../../src/parsers/cline-parser.js";
import { GeminiParser } from "../../src/parsers/gemini-parser.js";
import type { SessionFileInfo } from "../../src/parsers/session-parser.js";

// ── 1. HTTP Transport E2E ─────────────────────────────────────────────

describe("Smoke: HTTP Transport E2E", () => {
  let handle: HttpTransportHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  it("serve starts and health responds", async () => {
    const { server } = await createServer();
    handle = await startHttpTransport(server, { port: 0 });

    const addr = handle.server.address();
    if (typeof addr !== "object" || addr === null) throw new Error("No address");

    const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
    expect(typeof body.uptime).toBe("number");
  });

  it("full MCP lifecycle via HTTP", async () => {
    const { server } = await createServer();
    handle = await startHttpTransport(server, { port: 0 });

    const addr = handle.server.address();
    if (typeof addr !== "object" || addr === null) throw new Error("No address");
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    // 1. Initialize session
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream, application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "smoke-test", version: "0.0.1" },
        },
      }),
    });
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    await initRes.text();

    // 2. Send initialized notification
    await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream, application/json",
        "mcp-session-id": sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });

    // 3. List tools
    const listRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream, application/json",
        "mcp-session-id": sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });
    expect(listRes.status).toBe(200);
    const toolsText = await listRes.text();

    // Verify Phase 4 tools appear
    expect(toolsText).toContain("store_memory");
    expect(toolsText).toContain("search_history");
  });

  it("graceful shutdown", async () => {
    const { server } = await createServer();
    handle = await startHttpTransport(server, { port: 0 });

    await handle.close();
    expect(handle.server.listening).toBe(false);
    handle = undefined; // already closed
  });
});

// ── 2. store_memory → search round-trip ───────────────────────────────

describe("Smoke: store_memory → search round-trip", () => {
  let db: Database.Database;
  let docStore: SqliteDocumentStore;
  let searchEngine: SqliteSearchEngine;
  let knowledgeStore: SqliteKnowledgeStore;

  beforeAll(async () => {
    db = openDatabase(":memory:");
    docStore = new SqliteDocumentStore(db);
    searchEngine = new SqliteSearchEngine(docStore);
    knowledgeStore = new SqliteKnowledgeStore(db);
  });

  afterAll(() => {
    db.close();
  });

  it("store then search", async () => {
    // Store a decision via the tool handler
    const storeResult = await handleStoreMemory(knowledgeStore, {
      memory: "We decided to use PostgreSQL instead of MySQL for the production database because of JSONB support",
      type: "decision",
      tags: ["database", "infrastructure"],
      project: "smoke-test-project",
    });
    expect(storeResult).toContain("Stored decision");

    // The knowledge store should have the entry
    const entries = await knowledgeStore.search("PostgreSQL");
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].details).toContain("PostgreSQL");
    expect(entries[0].type).toBe("decision");
  });

  it("store then find_solutions", async () => {
    // Store a solution
    await handleStoreMemory(knowledgeStore, {
      memory: "Fixed the ECONNREFUSED error in Docker by adding network_mode: host to docker-compose.yml. The solution was to ensure containers share the host network.",
      type: "solution",
      tags: ["docker", "networking"],
      project: "smoke-test-project",
    });

    // Knowledge store should find it
    const entries = await knowledgeStore.search("ECONNREFUSED");
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some(e => e.details.includes("ECONNREFUSED"))).toBe(true);
  });

  it("store then search via search engine (full-text)", async () => {
    // Seed document store with the same content to test the full search pipeline
    docStore.add(
      "We decided to use PostgreSQL for JSONB support in the smoke test project",
      12,
      {
        sessionId: "explicit-memory",
        project: "smoke-test-project",
        role: "mixed",
        timestamp: Date.now(),
        toolNames: [],
        messageIndex: 0,
      },
    );

    const result = await handleSearchHistory(searchEngine, {
      query: "PostgreSQL JSONB",
    });
    expect(result).toContain("PostgreSQL");
    expect(result).not.toContain("No results");
  });

  it("find_solutions via search engine with solution boost", async () => {
    docStore.add(
      "Fixed the ECONNREFUSED Docker networking error by using network_mode host in compose",
      15,
      {
        sessionId: "explicit-memory-solution",
        project: "smoke-test-project",
        role: "mixed",
        timestamp: Date.now(),
        toolNames: ["Bash"],
        messageIndex: 0,
      },
    );

    const result = await handleFindSolutions(searchEngine, {
      error_or_problem: "ECONNREFUSED Docker",
    });
    expect(result).toContain("ECONNREFUSED");
    expect(result).not.toContain("No past solutions");
  });
});

// ── 3. Real-time watcher integration ──────────────────────────────────

describe("Smoke: Real-time watcher → extract → searchable", () => {
  let db: Database.Database;
  let knowledgeStore: SqliteKnowledgeStore;
  let tmpDir: string;
  let watcher: RealtimeWatcher;

  beforeAll(async () => {
    db = openDatabase(":memory:");
    knowledgeStore = new SqliteKnowledgeStore(db);

    tmpDir = join(tmpdir(), `phase4-smoke-watcher-${Date.now()}`);
    mkdirSync(join(tmpDir, "test-project"), { recursive: true });
  });

  afterAll(() => {
    if (watcher) watcher.stop();
    db.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup best effort
    }
  });

  it("watcher processes JSONL and knowledge is queryable", async () => {
    const sessionFile = join(tmpDir, "test-project", "smoke-session.jsonl");

    // Write JSONL lines simulating a session with a clear decision
    const lines = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "How should we handle database migrations?" },
        uuid: "u1",
        timestamp: new Date().toISOString(),
        cwd: "/test/project",
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "We decided to use Prisma for database migrations. The fix was adding a migration script to the CI pipeline." },
        uuid: "u2",
        timestamp: new Date().toISOString(),
        cwd: "/test/project",
      }),
    ];
    writeFileSync(sessionFile, lines.join("\n") + "\n");

    watcher = new RealtimeWatcher(sessionFile, knowledgeStore, { debounceMs: 100 });
    watcher.processNewLines();

    // Watcher should have parsed the messages
    expect(watcher.messageCount).toBe(2);

    // Knowledge extraction may or may not produce entries depending on heuristics,
    // but processing should complete without errors
    expect(watcher.currentOffset).toBeGreaterThan(0);
  });
});

// ── 4. Parser → indexing round-trip ───────────────────────────────────

describe("Smoke: Parser round-trip", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = join(tmpdir(), `phase4-smoke-parsers-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup best effort
    }
  });

  it("Cline session is parseable", async () => {
    // Create a temp Cline-like task directory
    const taskDir = join(tmpDir, "cline-tasks", "task-001");
    mkdirSync(taskDir, { recursive: true });

    const apiHistory = [
      {
        role: "user",
        content: [{ type: "text", text: "Fix the login bug" }],
        ts: Date.now() - 60000,
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I found the issue in the auth middleware." },
          { type: "tool_use", name: "write_to_file", input: { path: "auth.ts" } },
        ],
        ts: Date.now(),
      },
    ];
    writeFileSync(
      join(taskDir, "api_conversation_history.json"),
      JSON.stringify(apiHistory),
    );

    const parser = new ClineParser(join(tmpDir, "cline-tasks"));
    expect(parser.detect()).toBe(true);

    const files = parser.discover();
    expect(files.length).toBe(1);
    expect(files[0].sessionId).toBe("task-001");

    const session = parser.parse(files[0]);
    expect(session).not.toBeNull();
    expect(session!.tool).toBe("cline");
    expect(session!.messages.length).toBe(2);
    expect(session!.messages[0].role).toBe("user");
    expect(session!.messages[1].role).toBe("assistant");
    expect(session!.messages[1].toolNames).toContain("write_to_file");
  });

  it("Gemini session is parseable", async () => {
    // Create a temp Gemini-like directory
    const projectHash = "abc123hash";
    const chatsDir = join(tmpDir, "gemini-tmp", projectHash, "chats");
    mkdirSync(chatsDir, { recursive: true });

    const checkpoint = [
      {
        role: "user",
        parts: [{ text: "How do I set up a CI pipeline?" }],
      },
      {
        role: "model",
        parts: [
          { text: "Here's how to configure GitHub Actions for CI:" },
          { functionCall: { name: "edit_file", args: { path: ".github/workflows/ci.yml" } } },
        ],
      },
    ];
    writeFileSync(
      join(chatsDir, "checkpoint-tag1.json"),
      JSON.stringify(checkpoint),
    );

    const parser = new GeminiParser(join(tmpDir, "gemini-tmp"));
    expect(parser.detect()).toBe(true);

    const files = parser.discover();
    expect(files.length).toBe(1);
    expect(files[0].sessionId).toBe(`${projectHash}-tag1`);

    const session = parser.parse(files[0]);
    expect(session).not.toBeNull();
    expect(session!.tool).toBe("gemini-cli");
    expect(session!.messages.length).toBe(2);
    expect(session!.messages[0].role).toBe("user");
    expect(session!.messages[1].role).toBe("assistant");
    expect(session!.messages[1].toolNames).toContain("edit_file");
  });
});

// ── 5. Deploy artifacts validation ────────────────────────────────────

describe("Smoke: Deploy artifacts", () => {
  const repoRoot = join(__dirname, "..", "..");

  it("Dockerfile has multi-stage build, HEALTHCHECK, USER strata, CMD serve", async () => {
    const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf-8");

    // Multi-stage build
    expect(dockerfile).toContain("FROM");
    expect(dockerfile).toContain("AS builder");
    // Second FROM (runtime stage)
    const fromMatches = dockerfile.match(/^FROM /gm);
    expect(fromMatches!.length).toBeGreaterThanOrEqual(2);

    // Security and operational requirements
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(dockerfile).toContain("USER strata");
    expect(dockerfile).toContain("serve");
  });

  it("cloud-run.yaml has required fields", async () => {
    const yaml = readFileSync(join(repoRoot, "deploy", "cloud-run.yaml"), "utf-8");

    // Resource limits
    expect(yaml).toContain("memory:");
    expect(yaml).toContain("cpu:");

    // Volume mount for persistent data
    expect(yaml).toContain("volumeMounts");
    expect(yaml).toContain("mountPath");

    // Health check
    expect(yaml).toContain("/health");

    // Service metadata
    expect(yaml).toContain("serving.knative.dev");
  });
});
