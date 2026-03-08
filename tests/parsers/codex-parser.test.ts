/**
 * Tests for CodexParser — Codex CLI conversation parser.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { CodexParser } from "../../src/parsers/codex-parser.js";

/** Create a temp directory for test fixtures */
function makeTempDir(): string {
  const dir = join(tmpdir(), `codex-parser-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Build a JSONL string from an array of event objects */
function toJsonl(events: object[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/** Standard timestamps for fixtures */
const TS1 = "2025-06-15T10:00:00Z";
const TS2 = "2025-06-15T10:01:00Z";
const TS3 = "2025-06-15T10:02:00Z";

describe("CodexParser", () => {
  let tempDir: string;
  let parser: CodexParser;

  beforeEach(() => {
    tempDir = makeTempDir();
    parser = new CodexParser(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // --- detect() ---

  it("detect() returns true when sessions directory exists", () => {
    expect(parser.detect()).toBe(true);
  });

  it("detect() returns false when sessions directory does not exist", () => {
    const missing = new CodexParser(join(tempDir, "nonexistent"));
    expect(missing.detect()).toBe(false);
  });

  // --- discover() ---

  it("discover() returns empty array when no session files exist", () => {
    expect(parser.discover()).toEqual([]);
  });

  it("discover() finds rollout-*.jsonl files in YYYY/MM/DD structure", () => {
    const dayDir = join(tempDir, "2025", "06", "15");
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(join(dayDir, "rollout-abc123.jsonl"), "{}");
    writeFileSync(join(dayDir, "rollout-def456.jsonl"), "{}");
    // Non-matching file should be ignored
    writeFileSync(join(dayDir, "other-file.json"), "{}");

    const files = parser.discover();
    expect(files).toHaveLength(2);

    const ids = files.map((f) => f.sessionId).sort();
    expect(ids).toEqual(["abc123", "def456"]);

    // Check projectDir format
    expect(files[0].projectDir).toBe("codex/2025/06/15");
  });

  it("discover() walks multiple date directories", () => {
    const day1 = join(tempDir, "2025", "06", "15");
    const day2 = join(tempDir, "2025", "07", "01");
    mkdirSync(day1, { recursive: true });
    mkdirSync(day2, { recursive: true });
    writeFileSync(join(day1, "rollout-aaa.jsonl"), "{}");
    writeFileSync(join(day2, "rollout-bbb.jsonl"), "{}");

    const files = parser.discover();
    expect(files).toHaveLength(2);
  });

  // --- parse() ---

  it("parse() returns null for missing file", () => {
    const result = parser.parse({
      filePath: join(tempDir, "nonexistent.jsonl"),
      projectDir: "codex/2025/06/15",
      sessionId: "missing",
      mtime: 0,
      size: 0,
    });
    expect(result).toBeNull();
  });

  it("parse() extracts user and assistant messages from item.completed events", () => {
    const dayDir = join(tempDir, "2025", "06", "15");
    mkdirSync(dayDir, { recursive: true });
    const filePath = join(dayDir, "rollout-sess1.jsonl");

    const events = [
      { type: "thread.started", thread_id: "t1", timestamp: TS1 },
      {
        type: "item.completed",
        timestamp: TS1,
        item: { type: "userMessage", role: "user", content: "Hello, help me with code" },
      },
      {
        type: "item.completed",
        timestamp: TS2,
        item: { type: "agentMessage", role: "assistant", content: "Sure, I can help!" },
      },
    ];
    writeFileSync(filePath, toJsonl(events));

    const result = parser.parse({
      filePath,
      projectDir: "codex/2025/06/15",
      sessionId: "sess1",
      mtime: Date.now(),
      size: 100,
    });

    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(2);
    expect(result!.messages[0].role).toBe("user");
    expect(result!.messages[0].text).toBe("Hello, help me with code");
    expect(result!.messages[1].role).toBe("assistant");
    expect(result!.messages[1].text).toBe("Sure, I can help!");
    expect(result!.tool).toBe("codex");
  });

  it("parse() handles commandExecution items", () => {
    const dayDir = join(tempDir, "2025", "06", "15");
    mkdirSync(dayDir, { recursive: true });
    const filePath = join(dayDir, "rollout-cmd1.jsonl");

    const events = [
      {
        type: "item.completed",
        timestamp: TS1,
        item: { type: "commandExecution", command: "npm test", output: "All passed", exit_code: 0 },
      },
    ];
    writeFileSync(filePath, toJsonl(events));

    const result = parser.parse({
      filePath,
      projectDir: "codex/2025/06/15",
      sessionId: "cmd1",
      mtime: Date.now(),
      size: 100,
    });

    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(1);
    expect(result!.messages[0].toolNames).toEqual(["Bash"]);
    expect(result!.messages[0].toolInputSnippets).toEqual(["npm test"]);
    expect(result!.messages[0].text).toContain("[command] npm test");
    expect(result!.messages[0].text).toContain("All passed");
  });

  it("parse() handles fileChange items", () => {
    const dayDir = join(tempDir, "2025", "06", "15");
    mkdirSync(dayDir, { recursive: true });
    const filePath = join(dayDir, "rollout-fc1.jsonl");

    const events = [
      {
        type: "item.completed",
        timestamp: TS1,
        item: { type: "fileChange", file_path: "src/index.ts", diff: "+console.log('hi')" },
      },
    ];
    writeFileSync(filePath, toJsonl(events));

    const result = parser.parse({
      filePath,
      projectDir: "codex/2025/06/15",
      sessionId: "fc1",
      mtime: Date.now(),
      size: 100,
    });

    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(1);
    expect(result!.messages[0].toolNames).toEqual(["Write"]);
    expect(result!.messages[0].text).toContain("[file change] src/index.ts");
    expect(result!.messages[0].text).toContain("+console.log('hi')");
  });

  it("parse() extracts CWD from environment_context tags", () => {
    const dayDir = join(tempDir, "2025", "06", "15");
    mkdirSync(dayDir, { recursive: true });
    const filePath = join(dayDir, "rollout-cwd1.jsonl");

    const cwdContent = "<environment_context><cwd>/home/user/project</cwd></environment_context>\nActual question here";
    const events = [
      {
        type: "item.completed",
        timestamp: TS1,
        item: { type: "userMessage", role: "user", content: cwdContent },
      },
    ];
    writeFileSync(filePath, toJsonl(events));

    const result = parser.parse({
      filePath,
      projectDir: "codex/2025/06/15",
      sessionId: "cwd1",
      mtime: Date.now(),
      size: 100,
    });

    expect(result).not.toBeNull();
    expect(result!.cwd).toBe("/home/user/project");
    expect(result!.project).toBe("/home/user/project");
    // User message text should have environment_context stripped
    expect(result!.messages[0].text).toBe("Actual question here");
    expect(result!.messages[0].text).not.toContain("environment_context");
  });

  it("parse() handles array content format", () => {
    const dayDir = join(tempDir, "2025", "06", "15");
    mkdirSync(dayDir, { recursive: true });
    const filePath = join(dayDir, "rollout-arr1.jsonl");

    const events = [
      {
        type: "item.completed",
        timestamp: TS1,
        item: {
          type: "agentMessage",
          role: "assistant",
          content: [
            { type: "text", text: "First part" },
            { type: "text", text: "Second part" },
          ],
        },
      },
    ];
    writeFileSync(filePath, toJsonl(events));

    const result = parser.parse({
      filePath,
      projectDir: "codex/2025/06/15",
      sessionId: "arr1",
      mtime: Date.now(),
      size: 100,
    });

    expect(result).not.toBeNull();
    expect(result!.messages[0].text).toBe("First part\nSecond part");
  });

  it("parse() skips malformed JSONL lines gracefully", () => {
    const dayDir = join(tempDir, "2025", "06", "15");
    mkdirSync(dayDir, { recursive: true });
    const filePath = join(dayDir, "rollout-bad1.jsonl");

    const content = [
      "not valid json",
      JSON.stringify({ type: "item.completed", timestamp: TS1, item: { type: "userMessage", content: "Valid message" } }),
      "{broken",
    ].join("\n");
    writeFileSync(filePath, content);

    const result = parser.parse({
      filePath,
      projectDir: "codex/2025/06/15",
      sessionId: "bad1",
      mtime: Date.now(),
      size: 100,
    });

    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(1);
    expect(result!.messages[0].text).toBe("Valid message");
  });

  it("parse() tracks start and end timestamps", () => {
    const dayDir = join(tempDir, "2025", "06", "15");
    mkdirSync(dayDir, { recursive: true });
    const filePath = join(dayDir, "rollout-ts1.jsonl");

    const events = [
      { type: "thread.started", timestamp: TS1 },
      { type: "item.completed", timestamp: TS2, item: { type: "userMessage", content: "Hi" } },
      { type: "turn.completed", timestamp: TS3 },
    ];
    writeFileSync(filePath, toJsonl(events));

    const result = parser.parse({
      filePath,
      projectDir: "codex/2025/06/15",
      sessionId: "ts1",
      mtime: Date.now(),
      size: 100,
    });

    expect(result).not.toBeNull();
    expect(result!.startTime).toBe(new Date(TS1).getTime());
    expect(result!.endTime).toBe(new Date(TS3).getTime());
  });

  it("parse() returns null for empty session with no messages", () => {
    const dayDir = join(tempDir, "2025", "06", "15");
    mkdirSync(dayDir, { recursive: true });
    const filePath = join(dayDir, "rollout-empty.jsonl");

    const events = [
      { type: "thread.started", timestamp: TS1 },
      { type: "turn.started", timestamp: TS2 },
    ];
    writeFileSync(filePath, toJsonl(events));

    const result = parser.parse({
      filePath,
      projectDir: "codex/2025/06/15",
      sessionId: "empty",
      mtime: Date.now(),
      size: 100,
    });

    expect(result).toBeNull();
  });

  it("parse() shows non-zero exit code in command output", () => {
    const dayDir = join(tempDir, "2025", "06", "15");
    mkdirSync(dayDir, { recursive: true });
    const filePath = join(dayDir, "rollout-err1.jsonl");

    const events = [
      {
        type: "item.completed",
        timestamp: TS1,
        item: { type: "commandExecution", command: "npm test", output: "FAIL", exit_code: 1 },
      },
    ];
    writeFileSync(filePath, toJsonl(events));

    const result = parser.parse({
      filePath,
      projectDir: "codex/2025/06/15",
      sessionId: "err1",
      mtime: Date.now(),
      size: 100,
    });

    expect(result).not.toBeNull();
    expect(result!.messages[0].text).toContain("(exit 1)");
  });
});
