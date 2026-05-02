/**
 * TIRQDP-1.7 — parseTurns() roundtrip tests for all 5 conversation parsers.
 *
 * Verifies that:
 * - Each parser exposes parseTurns(file: SessionFileInfo): SessionMessage[]
 * - parseTurns() returns ≥1 turn for a valid fixture
 * - Returned array has correct speaker (role) and content snippets
 * - No parser throws
 *
 * NOTE: strata/tests/fixtures/parsers/ does not exist at ticket time.
 * Test data is constructed in-memory via temporary files, following the
 * pattern of claude-code-parser.test.ts / aider-parser.test.ts / etc.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { ClaudeCodeParser } from "../../src/parsers/claude-code-parser.js";
import { CodexParser } from "../../src/parsers/codex-parser.js";
import { AiderParser } from "../../src/parsers/aider-parser.js";
import { ClineParser } from "../../src/parsers/cline-parser.js";
import { GeminiParser } from "../../src/parsers/gemini-parser.js";

// ---------------------------------------------------------------------------
// Temp directory lifecycle
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = join(tmpdir(), `parseTurns-test-${Date.now()}`);
  mkdirSync(tmpRoot, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Helper: build a SessionFileInfo stub
// ---------------------------------------------------------------------------

function makeFileInfo(filePath: string, projectDir = "test-project", sessionId = "test-session") {
  return { filePath, projectDir, sessionId, mtime: Date.now(), size: 0 };
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

describe("parseTurns — ClaudeCodeParser", () => {
  it("returns ≥1 turn with correct role and content", () => {
    // Build a minimal JSONL fixture
    const dir = join(tmpRoot, "claude-code");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "session-abc.jsonl");

    const lines = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "parseTurns user message for claude" },
        timestamp: "2026-01-01T10:00:00Z",
        uuid: "u1",
        sessionId: "session-abc",
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "parseTurns assistant reply for claude" }],
        },
        timestamp: "2026-01-01T10:00:05Z",
        uuid: "a1",
        sessionId: "session-abc",
      }),
    ];
    writeFileSync(filePath, lines.join("\n"));

    const parser = new ClaudeCodeParser();
    const fileInfo = makeFileInfo(filePath);

    const turns = parser.parseTurns(fileInfo);

    expect(Array.isArray(turns)).toBe(true);
    expect(turns.length).toBeGreaterThanOrEqual(1);

    const userTurn = turns.find((t) => t.role === "user");
    expect(userTurn).toBeDefined();
    expect(userTurn!.text).toContain("parseTurns user message for claude");

    const assistantTurn = turns.find((t) => t.role === "assistant");
    expect(assistantTurn).toBeDefined();
    expect(assistantTurn!.text).toContain("parseTurns assistant reply for claude");
  });

  it("returns [] for a non-existent file (no throw)", () => {
    const parser = new ClaudeCodeParser();
    const fileInfo = makeFileInfo(join(tmpRoot, "does-not-exist.jsonl"));
    expect(() => parser.parseTurns(fileInfo)).not.toThrow();
    expect(parser.parseTurns(fileInfo)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

describe("parseTurns — CodexParser", () => {
  it("returns ≥1 turn with correct role and content", () => {
    // Build a minimal Codex JSONL fixture
    const dir = join(tmpRoot, "codex", "2026", "01", "01");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "rollout-test123.jsonl");

    const events = [
      JSON.stringify({
        type: "item.completed",
        timestamp: "2026-01-01T10:00:00Z",
        item: {
          type: "userMessage",
          content: "parseTurns user message for codex",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        timestamp: "2026-01-01T10:00:05Z",
        item: {
          type: "agentMessage",
          content: "parseTurns assistant reply for codex",
        },
      }),
    ];
    writeFileSync(filePath, events.join("\n"));

    const parser = new CodexParser(join(tmpRoot, "codex"));
    const fileInfo = makeFileInfo(filePath, "codex/2026/01/01", "test123");

    const turns = parser.parseTurns(fileInfo);

    expect(Array.isArray(turns)).toBe(true);
    expect(turns.length).toBeGreaterThanOrEqual(1);

    const userTurn = turns.find((t) => t.role === "user");
    expect(userTurn).toBeDefined();
    expect(userTurn!.text).toContain("parseTurns user message for codex");

    const assistantTurn = turns.find((t) => t.role === "assistant");
    expect(assistantTurn).toBeDefined();
    expect(assistantTurn!.text).toContain("parseTurns assistant reply for codex");
  });

  it("returns [] for a non-existent file (no throw)", () => {
    const parser = new CodexParser(join(tmpRoot, "codex"));
    const fileInfo = makeFileInfo(join(tmpRoot, "does-not-exist.jsonl"));
    expect(() => parser.parseTurns(fileInfo)).not.toThrow();
    expect(parser.parseTurns(fileInfo)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Aider
// ---------------------------------------------------------------------------

describe("parseTurns — AiderParser", () => {
  it("returns ≥1 turn with correct role and content", () => {
    const dir = join(tmpRoot, "aider-project");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, ".aider.chat.history.md");

    const content = [
      "#### parseTurns user message for aider",
      "",
      "parseTurns assistant reply for aider",
      "",
    ].join("\n");
    writeFileSync(filePath, content);

    const parser = new AiderParser([dir]);
    const fileInfo = makeFileInfo(filePath, "aider-project", "aider-test");

    const turns = parser.parseTurns(fileInfo);

    expect(Array.isArray(turns)).toBe(true);
    expect(turns.length).toBeGreaterThanOrEqual(1);

    const userTurn = turns.find((t) => t.role === "user");
    expect(userTurn).toBeDefined();
    expect(userTurn!.text).toContain("parseTurns user message for aider");

    const assistantTurn = turns.find((t) => t.role === "assistant");
    expect(assistantTurn).toBeDefined();
    expect(assistantTurn!.text).toContain("parseTurns assistant reply for aider");
  });

  it("returns [] for a non-existent file (no throw)", () => {
    const parser = new AiderParser([tmpRoot]);
    const fileInfo = makeFileInfo(join(tmpRoot, "does-not-exist.md"));
    expect(() => parser.parseTurns(fileInfo)).not.toThrow();
    expect(parser.parseTurns(fileInfo)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cline
// ---------------------------------------------------------------------------

describe("parseTurns — ClineParser", () => {
  it("returns ≥1 turn with correct role and content", () => {
    const taskId = "cline-task-001";
    const taskDir = join(tmpRoot, "cline-tasks", taskId);
    mkdirSync(taskDir, { recursive: true });
    const filePath = join(taskDir, "api_conversation_history.json");

    const history = [
      { role: "user", content: "parseTurns user message for cline" },
      { role: "assistant", content: "parseTurns assistant reply for cline" },
    ];
    writeFileSync(filePath, JSON.stringify(history));

    const parser = new ClineParser(join(tmpRoot, "cline-tasks"));
    const fileInfo = makeFileInfo(filePath, `cline/${taskId}`, taskId);

    const turns = parser.parseTurns(fileInfo);

    expect(Array.isArray(turns)).toBe(true);
    expect(turns.length).toBeGreaterThanOrEqual(1);

    const userTurn = turns.find((t) => t.role === "user");
    expect(userTurn).toBeDefined();
    expect(userTurn!.text).toContain("parseTurns user message for cline");

    const assistantTurn = turns.find((t) => t.role === "assistant");
    expect(assistantTurn).toBeDefined();
    expect(assistantTurn!.text).toContain("parseTurns assistant reply for cline");
  });

  it("returns [] for a non-existent file (no throw)", () => {
    const parser = new ClineParser(join(tmpRoot, "cline-tasks"));
    const fileInfo = makeFileInfo(join(tmpRoot, "does-not-exist.json"));
    expect(() => parser.parseTurns(fileInfo)).not.toThrow();
    expect(parser.parseTurns(fileInfo)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

describe("parseTurns — GeminiParser", () => {
  it("returns ≥1 turn with correct role and content (v2 format)", () => {
    const projectName = "gemini-test-project";
    const chatsDir = join(tmpRoot, "gemini-tmp", projectName, "chats");
    mkdirSync(chatsDir, { recursive: true });
    const filePath = join(chatsDir, "session-xyz.json");

    const session = {
      sessionId: "gemini-session-xyz",
      messages: [
        {
          type: "user",
          content: "parseTurns user message for gemini",
          timestamp: "2026-01-01T10:00:00Z",
        },
        {
          type: "gemini",
          content: "parseTurns assistant reply for gemini",
          timestamp: "2026-01-01T10:00:05Z",
        },
      ],
    };
    writeFileSync(filePath, JSON.stringify(session));

    const parser = new GeminiParser(join(tmpRoot, "gemini-tmp"));
    const fileInfo = makeFileInfo(filePath, `gemini/${projectName}`, "gemini-test-project-xyz");

    const turns = parser.parseTurns(fileInfo);

    expect(Array.isArray(turns)).toBe(true);
    expect(turns.length).toBeGreaterThanOrEqual(1);

    const userTurn = turns.find((t) => t.role === "user");
    expect(userTurn).toBeDefined();
    expect(userTurn!.text).toContain("parseTurns user message for gemini");

    const assistantTurn = turns.find((t) => t.role === "assistant");
    expect(assistantTurn).toBeDefined();
    expect(assistantTurn!.text).toContain("parseTurns assistant reply for gemini");
  });

  it("returns [] for a non-existent file (no throw)", () => {
    const parser = new GeminiParser(join(tmpRoot, "gemini-tmp"));
    const fileInfo = makeFileInfo(join(tmpRoot, "does-not-exist.json"));
    expect(() => parser.parseTurns(fileInfo)).not.toThrow();
    expect(parser.parseTurns(fileInfo)).toEqual([]);
  });
});
