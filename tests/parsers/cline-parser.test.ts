/**
 * Tests for ClineParser — Cline conversation parser.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ClineParser } from "../../src/parsers/cline-parser.js";

/** Create a temp directory for test fixtures */
function makeTempDir(): string {
  const dir = join(tmpdir(), `cline-parser-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("ClineParser", () => {
  let tempDir: string;
  let parser: ClineParser;

  beforeEach(() => {
    tempDir = makeTempDir();
    parser = new ClineParser(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // --- id and name ---

  it("has correct id and name", () => {
    expect(parser.id).toBe("cline");
    expect(parser.name).toBe("Cline");
  });

  // --- detect() ---

  it("detect() returns true when tasks directory exists", () => {
    expect(parser.detect()).toBe(true);
  });

  it("detect() returns false when tasks directory does not exist", () => {
    const missing = new ClineParser(join(tempDir, "nonexistent"));
    expect(missing.detect()).toBe(false);
  });

  // --- discover() ---

  it("discover() returns empty array when no task directories exist", () => {
    expect(parser.discover()).toEqual([]);
  });

  it("discover() finds task directories with api_conversation_history.json", () => {
    const task1 = join(tempDir, "task-abc123");
    const task2 = join(tempDir, "task-def456");
    mkdirSync(task1, { recursive: true });
    mkdirSync(task2, { recursive: true });
    writeFileSync(join(task1, "api_conversation_history.json"), "[]");
    writeFileSync(join(task2, "api_conversation_history.json"), "[]");

    const files = parser.discover();
    expect(files).toHaveLength(2);

    const ids = files.map((f) => f.sessionId).sort();
    expect(ids).toEqual(["task-abc123", "task-def456"]);
  });

  it("discover() ignores task directories without api_conversation_history.json", () => {
    const task1 = join(tempDir, "task-abc");
    const task2 = join(tempDir, "task-def");
    mkdirSync(task1, { recursive: true });
    mkdirSync(task2, { recursive: true });
    writeFileSync(join(task1, "api_conversation_history.json"), "[]");
    // task2 has no api file
    writeFileSync(join(task2, "ui_messages.json"), "[]");

    const files = parser.discover();
    expect(files).toHaveLength(1);
    expect(files[0].sessionId).toBe("task-abc");
  });

  it("discover() sets correct projectDir format", () => {
    const task = join(tempDir, "task-xyz");
    mkdirSync(task, { recursive: true });
    writeFileSync(join(task, "api_conversation_history.json"), "[]");

    const files = parser.discover();
    expect(files[0].projectDir).toBe("cline/task-xyz");
  });

  // --- parse() ---

  it("parse() returns null for missing file", () => {
    const result = parser.parse({
      filePath: join(tempDir, "nonexistent", "api_conversation_history.json"),
      projectDir: "cline/task-1",
      sessionId: "task-1",
      mtime: 0,
      size: 0,
    });
    expect(result).toBeNull();
  });

  it("parse() returns null for invalid JSON", () => {
    const taskDir = join(tempDir, "task-bad");
    mkdirSync(taskDir, { recursive: true });
    const filePath = join(taskDir, "api_conversation_history.json");
    writeFileSync(filePath, "not valid json");

    const result = parser.parse({
      filePath,
      projectDir: "cline/task-bad",
      sessionId: "task-bad",
      mtime: Date.now(),
      size: 100,
    });
    expect(result).toBeNull();
  });

  it("parse() returns null for non-array JSON", () => {
    const taskDir = join(tempDir, "task-obj");
    mkdirSync(taskDir, { recursive: true });
    const filePath = join(taskDir, "api_conversation_history.json");
    writeFileSync(filePath, JSON.stringify({ not: "an array" }));

    const result = parser.parse({
      filePath,
      projectDir: "cline/task-obj",
      sessionId: "task-obj",
      mtime: Date.now(),
      size: 100,
    });
    expect(result).toBeNull();
  });

  it("parse() extracts user and assistant messages from string content", () => {
    const taskDir = join(tempDir, "task-msg");
    mkdirSync(taskDir, { recursive: true });
    const filePath = join(taskDir, "api_conversation_history.json");

    const messages = [
      { role: "user", content: "Help me write a function", ts: 1700000000000 },
      { role: "assistant", content: "Sure, here is a function:\n```js\nfunction hello() {}\n```", ts: 1700000001000 },
    ];
    writeFileSync(filePath, JSON.stringify(messages));

    const result = parser.parse({
      filePath,
      projectDir: "cline/task-msg",
      sessionId: "task-msg",
      mtime: Date.now(),
      size: 100,
    });

    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(2);
    expect(result!.messages[0].role).toBe("user");
    expect(result!.messages[0].text).toBe("Help me write a function");
    expect(result!.messages[1].role).toBe("assistant");
    expect(result!.messages[1].hasCode).toBe(true);
    expect(result!.tool).toBe("cline");
  });

  it("parse() extracts messages from content block arrays", () => {
    const taskDir = join(tempDir, "task-blocks");
    mkdirSync(taskDir, { recursive: true });
    const filePath = join(taskDir, "api_conversation_history.json");

    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check that file." },
          { type: "tool_use", name: "read_file", input: { path: "src/index.ts" } },
        ],
      },
    ];
    writeFileSync(filePath, JSON.stringify(messages));

    const result = parser.parse({
      filePath,
      projectDir: "cline/task-blocks",
      sessionId: "task-blocks",
      mtime: Date.now(),
      size: 100,
    });

    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(1);
    expect(result!.messages[0].toolNames).toEqual(["read_file"]);
    expect(result!.messages[0].toolInputSnippets.length).toBeGreaterThan(0);
    expect(result!.messages[0].text).toContain("Let me check that file.");
    expect(result!.messages[0].text).toContain("[tool: read_file]");
  });

  it("parse() handles tool_result content blocks", () => {
    const taskDir = join(tempDir, "task-toolresult");
    mkdirSync(taskDir, { recursive: true });
    const filePath = join(taskDir, "api_conversation_history.json");

    const messages = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "File contents here" },
        ],
      },
    ];
    writeFileSync(filePath, JSON.stringify(messages));

    const result = parser.parse({
      filePath,
      projectDir: "cline/task-toolresult",
      sessionId: "task-toolresult",
      mtime: Date.now(),
      size: 100,
    });

    expect(result).not.toBeNull();
    expect(result!.messages[0].text).toContain("[tool result]");
  });

  it("parse() tracks timestamps from ts field", () => {
    const taskDir = join(tempDir, "task-ts");
    mkdirSync(taskDir, { recursive: true });
    const filePath = join(taskDir, "api_conversation_history.json");

    const messages = [
      { role: "user", content: "First", ts: 1700000000000 },
      { role: "assistant", content: "Second", ts: 1700000060000 },
    ];
    writeFileSync(filePath, JSON.stringify(messages));

    const result = parser.parse({
      filePath,
      projectDir: "cline/task-ts",
      sessionId: "task-ts",
      mtime: Date.now(),
      size: 100,
    });

    expect(result).not.toBeNull();
    expect(result!.startTime).toBe(1700000000000);
    expect(result!.endTime).toBe(1700000060000);
  });

  it("parse() returns null for empty conversation array", () => {
    const taskDir = join(tempDir, "task-empty");
    mkdirSync(taskDir, { recursive: true });
    const filePath = join(taskDir, "api_conversation_history.json");
    writeFileSync(filePath, "[]");

    const result = parser.parse({
      filePath,
      projectDir: "cline/task-empty",
      sessionId: "task-empty",
      mtime: Date.now(),
      size: 2,
    });

    expect(result).toBeNull();
  });

  it("parse() reads task_metadata.json for project info", () => {
    const taskDir = join(tempDir, "task-meta");
    mkdirSync(taskDir, { recursive: true });
    const filePath = join(taskDir, "api_conversation_history.json");
    writeFileSync(filePath, JSON.stringify([
      { role: "user", content: "Hello" },
    ]));
    writeFileSync(join(taskDir, "task_metadata.json"), JSON.stringify({
      task_name: "My Cool Task",
      cwd: "/home/user/project",
    }));

    const result = parser.parse({
      filePath,
      projectDir: "cline/task-meta",
      sessionId: "task-meta",
      mtime: Date.now(),
      size: 100,
    });

    expect(result).not.toBeNull();
    expect(result!.project).toBe("My Cool Task");
    expect(result!.cwd).toBe("/home/user/project");
  });

  it("parse() gracefully handles malformed entries in array", () => {
    const taskDir = join(tempDir, "task-partial");
    mkdirSync(taskDir, { recursive: true });
    const filePath = join(taskDir, "api_conversation_history.json");

    const messages = [
      null,
      { role: "user", content: "Valid message" },
      { noRole: true },
      { role: "assistant", content: "" },
    ];
    writeFileSync(filePath, JSON.stringify(messages));

    const result = parser.parse({
      filePath,
      projectDir: "cline/task-partial",
      sessionId: "task-partial",
      mtime: Date.now(),
      size: 100,
    });

    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(1);
    expect(result!.messages[0].text).toBe("Valid message");
  });
});
