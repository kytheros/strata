/**
 * TIRQDP-1.9 — strata index --rebuild-turns CLI
 *
 * Integration test that:
 *   1. Seeds sessions into the `documents` table (simulating indexed sessions)
 *   2. Deletes all rows from `knowledge_turns`
 *   3. Calls rebuildTurns() directly (function exported from rebuild-turns.ts)
 *   4. Asserts rows are written to knowledge_turns
 *   5. Runs a second time and asserts idempotent (same final state, no duplicates)
 *
 * Uses an in-memory SQLite DB so there is no filesystem dependency.
 * Parsers are stubbed via a minimal ParserRegistry so the test is deterministic.
 *
 * Written BEFORE the implementation (RED step first — TIRQDP-1.9).
 */

// ── Module mocks (must be first) ──────────────────────────────────────────────

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Prevent real SqliteIndexManager from opening ~/.strata/strata.db
vi.mock("../../src/indexing/sqlite-index-manager.js", () => {
  const registry = {
    getAll: vi.fn(() => []),
    detectAvailable: vi.fn(() => []),
    getById: vi.fn(() => undefined),
    register: vi.fn(),
  };
  return {
    SqliteIndexManager: vi.fn().mockImplementation(() => ({
      registry,
      close: vi.fn(),
    })),
  };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteKnowledgeTurnStore } from "../../src/storage/sqlite-knowledge-turn-store.js";
import { rebuildTurns } from "../../src/cli/rebuild-turns.js";
import type { ConversationParser } from "../../src/parsers/parser-interface.js";
import type { SessionFileInfo, SessionMessage, ParsedSession } from "../../src/parsers/session-parser.js";
import { ParserRegistry } from "../../src/parsers/parser-registry.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMessages(count: number, sessionId: string): SessionMessage[] {
  const msgs: SessionMessage[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push({
      role: i % 2 === 0 ? "user" : "assistant",
      text: `Message ${i} for session ${sessionId}`,
      toolNames: [],
      toolInputSnippets: [],
      hasCode: false,
      timestamp: new Date(Date.now() + i * 1000).toISOString(),
      uuid: `uuid-${sessionId}-${i}`,
    });
  }
  return msgs;
}

function makeSessionFileInfo(sessionId: string): SessionFileInfo {
  return {
    filePath: `/mock/sessions/${sessionId}.jsonl`,
    projectDir: "test-project",
    sessionId,
    mtime: Date.now(),
    size: 1024,
  };
}

/**
 * Create a minimal stub parser that owns the given sessions.
 */
function makeStubParser(
  id: string,
  sessions: Array<{ sessionId: string; messageCount: number; project?: string }>
): ConversationParser {
  const fileInfos = sessions.map((s) => makeSessionFileInfo(s.sessionId));
  const sessionMap = new Map(
    sessions.map((s) => [
      s.sessionId,
      makeMessages(s.messageCount, s.sessionId),
    ])
  );

  return {
    id,
    name: `Stub-${id}`,
    detect: () => true,
    discover: () => fileInfos,
    parse: (file: SessionFileInfo) => {
      const messages = sessionMap.get(file.sessionId) ?? [];
      return {
        sessionId: file.sessionId,
        project: sessions.find((s) => s.sessionId === file.sessionId)?.project ?? "test-project",
        cwd: "/mock",
        gitBranch: "main",
        messages,
        startTime: Date.now() - 60000,
        endTime: Date.now(),
        tool: id,
      } satisfies ParsedSession;
    },
    parseTurns: (file: SessionFileInfo) => sessionMap.get(file.sessionId) ?? [],
  };
}

/**
 * Seed `documents` rows so the DB has "known" sessions.
 */
function seedDocuments(
  db: Database.Database,
  sessions: Array<{ sessionId: string; project?: string; tool?: string }>
): void {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO documents
      (id, session_id, project, tool, text, role, timestamp, token_count, message_index, user)
    VALUES
      (@id, @session_id, @project, @tool, @text, @role, @timestamp, @token_count, @message_index, @user)
  `);
  for (const s of sessions) {
    stmt.run({
      id: `doc-${s.sessionId}`,
      session_id: s.sessionId,
      project: s.project ?? "test-project",
      tool: s.tool ?? "claude-code",
      text: "seeded chunk",
      role: "mixed",
      timestamp: Date.now(),
      token_count: 10,
      message_index: 0,
      user: "default",
    });
  }
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("rebuildTurns (TIRQDP-1.9)", () => {
  let db: Database.Database;
  let turnStore: SqliteKnowledgeTurnStore;

  beforeEach(() => {
    vi.clearAllMocks();
    db = openDatabase(":memory:");
    turnStore = new SqliteKnowledgeTurnStore(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
  });

  // ── basic: rows are written ─────────────────────────────────────────────────

  it("writes turns for all discovered sessions", async () => {
    const sessions = [
      { sessionId: "sess-001", messageCount: 3 },
      { sessionId: "sess-002", messageCount: 2 },
      { sessionId: "sess-003", messageCount: 4 },
    ];
    seedDocuments(db, sessions);

    const registry = new ParserRegistry();
    registry.register(makeStubParser("claude-code", sessions));

    const result = await rebuildTurns({ db, turnStore, registry });

    expect(result.sessionsProcessed).toBe(3);
    expect(result.turnsWritten).toBe(9); // 3 + 2 + 4

    // Verify rows are present in the store
    const count = db.prepare("SELECT COUNT(*) AS cnt FROM knowledge_turns").get() as { cnt: number };
    expect(count.cnt).toBe(9);
  });

  it("writes turns with correct session_id, speaker, content, and messageIndex", async () => {
    const sessions = [{ sessionId: "sess-100", messageCount: 3 }];
    seedDocuments(db, sessions);

    const registry = new ParserRegistry();
    registry.register(makeStubParser("claude-code", sessions));

    await rebuildTurns({ db, turnStore, registry });

    const rows = await turnStore.getBySessionId("sess-100");
    expect(rows).toHaveLength(3);
    expect(rows[0].sessionId).toBe("sess-100");
    expect(rows[0].speaker).toBe("user");
    expect(rows[1].speaker).toBe("assistant");
    expect(rows[2].speaker).toBe("user");
    for (let i = 0; i < 3; i++) {
      expect(rows[i].messageIndex).toBe(i);
      expect(rows[i].content).toBe(`Message ${i} for session sess-100`);
    }
  });

  // ── --project filter ────────────────────────────────────────────────────────

  it("filters by project when --project is specified", async () => {
    const sessions = [
      { sessionId: "proj-a-1", messageCount: 2, project: "project-alpha" },
      { sessionId: "proj-b-1", messageCount: 2, project: "project-beta" },
    ];
    seedDocuments(db, sessions);

    const registry = new ParserRegistry();
    registry.register(makeStubParser("claude-code", sessions));

    const result = await rebuildTurns({ db, turnStore, registry, project: "project-alpha" });

    expect(result.sessionsProcessed).toBe(1);
    expect(result.turnsWritten).toBe(2);

    const aRows = await turnStore.getBySessionId("proj-a-1");
    const bRows = await turnStore.getBySessionId("proj-b-1");
    expect(aRows).toHaveLength(2);
    expect(bRows).toHaveLength(0);
  });

  // ── --dry-run ───────────────────────────────────────────────────────────────

  it("--dry-run: reports counts without writing to knowledge_turns", async () => {
    const sessions = [
      { sessionId: "dry-001", messageCount: 3 },
    ];
    seedDocuments(db, sessions);

    const registry = new ParserRegistry();
    registry.register(makeStubParser("claude-code", sessions));

    const result = await rebuildTurns({ db, turnStore, registry, dryRun: true });

    // Counts are still reported
    expect(result.turnsWritten).toBe(3);
    expect(result.sessionsProcessed).toBe(1);

    // But nothing was actually written
    const count = db.prepare("SELECT COUNT(*) AS cnt FROM knowledge_turns").get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  // ── idempotent ──────────────────────────────────────────────────────────────

  it("is idempotent: running twice produces the same final state, no duplicates", async () => {
    const sessions = [
      { sessionId: "idem-001", messageCount: 3 },
      { sessionId: "idem-002", messageCount: 2 },
    ];
    seedDocuments(db, sessions);

    const registry = new ParserRegistry();
    registry.register(makeStubParser("claude-code", sessions));

    // First run
    const result1 = await rebuildTurns({ db, turnStore, registry });
    expect(result1.turnsWritten).toBe(5);

    const count1 = db.prepare("SELECT COUNT(*) AS cnt FROM knowledge_turns").get() as { cnt: number };
    expect(count1.cnt).toBe(5);

    // Second run — same result, no duplicates
    const result2 = await rebuildTurns({ db, turnStore, registry });
    expect(result2.turnsWritten).toBe(5);

    const count2 = db.prepare("SELECT COUNT(*) AS cnt FROM knowledge_turns").get() as { cnt: number };
    expect(count2.cnt).toBe(5);
  });

  // ── multi-parser ────────────────────────────────────────────────────────────

  it("processes sessions from multiple parsers", async () => {
    const claudeSessions = [
      { sessionId: "claude-001", messageCount: 2, tool: "claude-code" },
    ];
    const codexSessions = [
      { sessionId: "codex-001", messageCount: 3, tool: "codex" },
    ];
    seedDocuments(db, [...claudeSessions, ...codexSessions]);

    const registry = new ParserRegistry();
    registry.register(makeStubParser("claude-code", claudeSessions));
    registry.register(makeStubParser("codex", codexSessions));

    const result = await rebuildTurns({ db, turnStore, registry });

    expect(result.sessionsProcessed).toBe(2);
    expect(result.turnsWritten).toBe(5);
  });

  // ── sessions with no turns are skipped ──────────────────────────────────────

  it("skips sessions where parseTurns returns empty array", async () => {
    const sessions = [
      { sessionId: "empty-sess", messageCount: 0 },
      { sessionId: "nonempty-sess", messageCount: 2 },
    ];
    seedDocuments(db, sessions);

    const registry = new ParserRegistry();
    registry.register(makeStubParser("claude-code", sessions));

    const result = await rebuildTurns({ db, turnStore, registry });

    // empty-sess is processed (0 turns) and nonempty-sess has 2
    expect(result.sessionsProcessed).toBe(2);
    expect(result.turnsWritten).toBe(2);
  });
});
