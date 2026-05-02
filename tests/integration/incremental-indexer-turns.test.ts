/**
 * TIRQDP-1.8 — IncrementalIndexer write-side branch: knowledge_turns
 *
 * Integration test that:
 *   1. Wires a real SqliteKnowledgeTurnStore into IncrementalIndexer
 *   2. Fires handleFileChange() with a mock parser session
 *   3. Asserts rows appear in knowledge_turns (new TIR branch)
 *   4. Asserts existing knowledge extraction path is unaffected (no regression)
 *   5. Asserts no-op when turnStore is absent (D3 invisible-by-default)
 *
 * Uses vi.mock() for all heavy deps (same pattern as
 * tests/watcher/incremental-indexer.test.ts) to keep the test fast and
 * deterministic while still exercising the real SQLite turn-store writes.
 *
 * Written BEFORE the implementation (RED step first).
 */

// ── Module mocks (must be first, before any imports) ─────────────────────────

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("../../src/config.js", () => ({
  CONFIG: {
    projectsDir: "/mock/.claude/projects",
    claudeDir: "/mock/.claude",
    watcher: { debounceMs: 100, staleSessionMinutes: 0 },
    learning: { maxLearningsPerProject: 20, maxLearningLength: 200, memoryLineBudget: 200 },
    indexing: { chunkSize: 500, maxChunksPerSession: 100 },
    importance: { typeWeight: 0.35, languageWeight: 0.20, frequencyWeight: 0.35, explicitWeight: 0.10, boostMax: 0.5 },
    extraWatchDirs: [],
  },
}));

vi.mock("../../src/parsers/session-parser.js", () => ({
  parseSessionFile: vi.fn(),
}));

vi.mock("../../src/knowledge/knowledge-extractor.js", () => ({
  extractKnowledge: vi.fn(() => []),
}));

vi.mock("../../src/knowledge/session-summarizer.js", () => ({
  summarizeSession: vi.fn(() => ({ sessionId: "s1", summary: "test" })),
  cacheSummary: vi.fn(),
}));

vi.mock("../../src/extensions/llm-extraction/gemini-provider.js", () => ({
  getCachedGeminiProvider: vi.fn(async () => null),
}));

vi.mock("../../src/extensions/llm-extraction/enhanced-extractor.js", () => ({
  enhancedExtract: vi.fn(async () => []),
}));

vi.mock("../../src/extensions/llm-extraction/smart-summarizer.js", () => ({
  smartSummarize: vi.fn(async () => ({ sessionId: "s1", summary: "test" })),
}));

vi.mock("../../src/extensions/llm-extraction/provider-factory.js", () => ({
  getExtractionProvider: vi.fn(async () => null),
  getSummarizationProvider: vi.fn(async () => null),
}));

vi.mock("../../src/knowledge/learning-synthesizer.js", () => ({
  synthesizeLearnings: vi.fn(() => []),
}));

vi.mock("../../src/knowledge/memory-writer.js", () => ({
  writeLearningsToMemory: vi.fn(),
}));

vi.mock("../../src/knowledge/entity-extractor.js", () => ({
  extractEntities: vi.fn(() => []),
  extractRelations: vi.fn(() => []),
}));

vi.mock("../../src/knowledge/procedure-extractor.js", () => ({
  extractProcedures: vi.fn(() => []),
}));

vi.mock("../../src/knowledge/conflict-resolver.js", () => ({
  resolveConflicts: vi.fn(),
  executeResolution: vi.fn(),
}));

vi.mock("../../src/watcher/file-watcher.js", () => {
  return {
    FileWatcher: vi.fn().mockImplementation(() => ({
      start: vi.fn(),
      stop: vi.fn(),
    })),
    getWatchTargets: vi.fn(() => [
      { dir: "/mock/.claude/projects", glob: "*.jsonl", extensions: [".jsonl"], parserId: "claude-code" },
    ]),
  };
});

vi.mock("fs", async () => {
  const actual = await vi.importActual("fs");
  return {
    ...actual,
    statSync: vi.fn(() => ({
      mtimeMs: Date.now() - 600000, // 10 min ago (stale — passes age check)
      size: 1024,
    })),
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => ""),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    copyFileSync: vi.fn(),
  };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import { SqliteKnowledgeTurnStore } from "../../src/storage/sqlite-knowledge-turn-store.js";
import { IncrementalIndexer } from "../../src/watcher/incremental-indexer.js";
import { parseSessionFile } from "../../src/parsers/session-parser.js";
import type { ParserRegistry } from "../../src/parsers/parser-registry.js";
import type { ConversationParser } from "../../src/parsers/parser-interface.js";
import type { ParsedSession, SessionFileInfo } from "../../src/parsers/session-parser.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    sessionId: "test-session-001",
    project: "test-project",
    cwd: "/test",
    gitBranch: "main",
    messages: [
      {
        role: "user",
        text: "How do I set up dependency injection in TypeScript?",
        toolNames: [],
        toolInputSnippets: [],
        hasCode: false,
        timestamp: "2026-01-01T10:00:00Z",
        uuid: "msg-001",
      },
      {
        role: "assistant",
        text: "I'll show you how to implement dependency injection using constructor injection.",
        toolNames: ["Write"],
        toolInputSnippets: [],
        hasCode: true,
        timestamp: "2026-01-01T10:00:05Z",
        uuid: "msg-002",
      },
      {
        role: "user",
        text: "Can you add tests for that?",
        toolNames: [],
        toolInputSnippets: [],
        hasCode: false,
        timestamp: "2026-01-01T10:00:10Z",
        uuid: "msg-003",
      },
    ],
    startTime: Date.now() - 60000,
    endTime: Date.now(),
    tool: "claude-code",
    ...overrides,
  };
}

function makeIndexManager() {
  return {
    incrementalUpdate: vi.fn(async () => ({ added: 0, updated: 0, unchanged: 0 })),
    save: vi.fn(async () => {}),
  };
}

function makeMockKnowledgeStore() {
  return {
    addEntry: vi.fn(),
    save: vi.fn(),
    getGlobalLearnings: vi.fn(() => []),
  };
}

// ── Suite: turn-write branch with real SQLite ─────────────────────────────────

describe("IncrementalIndexer turn-write branch (TIRQDP-1.8)", () => {
  let db: Database.Database;
  let turnStore: SqliteKnowledgeTurnStore;

  beforeEach(() => {
    vi.clearAllMocks();
    // Fresh in-memory DB for each test (openDatabase creates all tables incl. knowledge_turns)
    db = openDatabase(":memory:");
    turnStore = new SqliteKnowledgeTurnStore(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
  });

  it("writes turns to knowledge_turns after handleFileChange", async () => {
    const session = makeSession();
    vi.mocked(parseSessionFile).mockReturnValue(session);

    const indexer = new IncrementalIndexer(
      makeIndexManager() as any,
      makeMockKnowledgeStore() as any,
      undefined,
      undefined,
      turnStore   // 5th param: the new TIRQDP-1.8 turnStore
    );

    await (indexer as any).handleFileChange("test-project/session-001.jsonl", "claude-code");

    expect(await turnStore.count()).toBe(session.messages.length);
  });

  it("turns have correct session_id", async () => {
    const session = makeSession({ sessionId: "abc-session" });
    vi.mocked(parseSessionFile).mockReturnValue(session);

    const indexer = new IncrementalIndexer(
      makeIndexManager() as any,
      makeMockKnowledgeStore() as any,
      undefined, undefined, turnStore
    );

    await (indexer as any).handleFileChange("test-project/abc-session.jsonl", "claude-code");

    const turns = await turnStore.getBySessionId("abc-session");
    expect(turns.length).toBe(session.messages.length);
    for (const turn of turns) {
      expect(turn.sessionId).toBe("abc-session");
    }
  });

  it("turns carry correct speaker (user/assistant)", async () => {
    const session = makeSession();
    vi.mocked(parseSessionFile).mockReturnValue(session);

    const indexer = new IncrementalIndexer(
      makeIndexManager() as any,
      makeMockKnowledgeStore() as any,
      undefined, undefined, turnStore
    );

    await (indexer as any).handleFileChange("test-project/session-001.jsonl", "claude-code");

    const turns = await turnStore.getBySessionId(session.sessionId);
    const speakers = turns.map(t => t.speaker);
    expect(speakers[0]).toBe("user");
    expect(speakers[1]).toBe("assistant");
    expect(speakers[2]).toBe("user");
  });

  it("turns carry verbatim content", async () => {
    const session = makeSession();
    vi.mocked(parseSessionFile).mockReturnValue(session);

    const indexer = new IncrementalIndexer(
      makeIndexManager() as any,
      makeMockKnowledgeStore() as any,
      undefined, undefined, turnStore
    );

    await (indexer as any).handleFileChange("test-project/session-001.jsonl", "claude-code");

    const turns = await turnStore.getBySessionId(session.sessionId);
    expect(turns[0].content).toBe(session.messages[0].text);
    expect(turns[1].content).toBe(session.messages[1].text);
    expect(turns[2].content).toBe(session.messages[2].text);
  });

  it("turns have monotonically increasing message_index from 0", async () => {
    const session = makeSession();
    vi.mocked(parseSessionFile).mockReturnValue(session);

    const indexer = new IncrementalIndexer(
      makeIndexManager() as any,
      makeMockKnowledgeStore() as any,
      undefined, undefined, turnStore
    );

    await (indexer as any).handleFileChange("test-project/session-001.jsonl", "claude-code");

    const turns = await turnStore.getBySessionId(session.sessionId);
    for (let i = 0; i < turns.length; i++) {
      expect(turns[i].messageIndex).toBe(i);
    }
  });

  it("turns have project set from session.project", async () => {
    const session = makeSession({ project: "my-special-project" });
    vi.mocked(parseSessionFile).mockReturnValue(session);

    const indexer = new IncrementalIndexer(
      makeIndexManager() as any,
      makeMockKnowledgeStore() as any,
      undefined, undefined, turnStore
    );

    await (indexer as any).handleFileChange("test-project/session-001.jsonl", "claude-code");

    const turns = await turnStore.getBySessionId(session.sessionId);
    for (const turn of turns) {
      expect(turn.project).toBe("my-special-project");
    }
  });

  // ── Regression guard: existing knowledge extraction path unaffected ────────

  it("existing chunk path: knowledgeStore.addEntry is NOT broken (regression check)", async () => {
    const session = makeSession();
    vi.mocked(parseSessionFile).mockReturnValue(session);

    // Mock extractKnowledge to return one entry (forces addEntry path)
    const { extractKnowledge } = await import("../../src/knowledge/knowledge-extractor.js");
    vi.mocked(extractKnowledge).mockReturnValueOnce([
      {
        id: "k1", summary: "DI pattern", details: "constructor injection", tags: [],
        timestamp: Date.now(), type: "pattern", sessionId: "test-session-001",
        project: "test-project", occurrences: 1, projectCount: 1,
      } as any,
    ]);

    const knowledgeStore = makeMockKnowledgeStore();
    const indexer = new IncrementalIndexer(
      makeIndexManager() as any,
      knowledgeStore as any,
      undefined, undefined, turnStore
    );

    await (indexer as any).handleFileChange("test-project/session-001.jsonl", "claude-code");

    // The knowledge store must have been called (existing path untouched)
    expect(knowledgeStore.addEntry).toHaveBeenCalledTimes(1);
    // AND turns were also written
    expect(await turnStore.count()).toBe(session.messages.length);
  });
});

// ── Suite: D3 invisible-by-default — no-op when turnStore absent ──────────────

describe("IncrementalIndexer turn-write branch — no-op when turnStore absent", () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
  });

  it("does not write knowledge_turns when turnStore is absent", async () => {
    const session = makeSession();
    vi.mocked(parseSessionFile).mockReturnValue(session);

    // Construct WITHOUT turnStore (5th param omitted — D3 flag-off)
    const indexer = new IncrementalIndexer(
      makeIndexManager() as any,
      makeMockKnowledgeStore() as any,
      undefined,
      undefined
      // no turnStore
    );

    await (indexer as any).handleFileChange("test-project/session-001.jsonl", "claude-code");

    // knowledge_turns table exists (schema ran) but has 0 rows
    const count = db
      .prepare("SELECT COUNT(*) AS cnt FROM knowledge_turns")
      .get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });
});
