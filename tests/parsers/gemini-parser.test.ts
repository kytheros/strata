/**
 * Tests for GeminiParser — Gemini CLI conversation parser.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { GeminiParser } from "../../src/parsers/gemini-parser.js";

/** Create a temp directory for test fixtures */
function makeTempDir(): string {
  const dir = join(tmpdir(), `gemini-parser-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("GeminiParser", () => {
  let tempDir: string;
  let parser: GeminiParser;

  beforeEach(() => {
    tempDir = makeTempDir();
    parser = new GeminiParser(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // --- id and name ---

  it("has correct id and name", () => {
    expect(parser.id).toBe("gemini-cli");
    expect(parser.name).toBe("Gemini CLI");
  });

  // --- detect() ---

  it("detect() returns true when tmp directory exists", () => {
    expect(parser.detect()).toBe(true);
  });

  it("detect() returns false when tmp directory does not exist", () => {
    const missing = new GeminiParser(join(tempDir, "nonexistent"));
    expect(missing.detect()).toBe(false);
  });

  // --- discover() ---

  it("discover() returns empty array when no project dirs exist", () => {
    expect(parser.discover()).toEqual([]);
  });

  it("discover() finds checkpoint files in project hash dirs", () => {
    const chatsDir = join(tempDir, "abc123hash", "chats");
    mkdirSync(chatsDir, { recursive: true });
    writeFileSync(join(chatsDir, "checkpoint-v1.json"), "[]");
    writeFileSync(join(chatsDir, "checkpoint-v2.json"), "[]");
    // Non-matching file should be ignored
    writeFileSync(join(chatsDir, "other.json"), "[]");

    const files = parser.discover();
    expect(files).toHaveLength(2);

    const ids = files.map((f) => f.sessionId).sort();
    expect(ids).toEqual(["abc123hash-v1", "abc123hash-v2"]);
  });

  it("discover() walks multiple project hash directories", () => {
    const chats1 = join(tempDir, "proj1hash", "chats");
    const chats2 = join(tempDir, "proj2hash", "chats");
    mkdirSync(chats1, { recursive: true });
    mkdirSync(chats2, { recursive: true });
    writeFileSync(join(chats1, "checkpoint-a.json"), "[]");
    writeFileSync(join(chats2, "checkpoint-b.json"), "[]");

    const files = parser.discover();
    expect(files).toHaveLength(2);
  });

  it("discover() sets correct projectDir format", () => {
    const chatsDir = join(tempDir, "myhash", "chats");
    mkdirSync(chatsDir, { recursive: true });
    writeFileSync(join(chatsDir, "checkpoint-tag1.json"), "[]");

    const files = parser.discover();
    expect(files[0].projectDir).toBe("gemini/myhash");
  });

  it("discover() ignores project dirs without chats subdirectory", () => {
    const projDir = join(tempDir, "nochats");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "checkpoint-x.json"), "[]");

    const files = parser.discover();
    expect(files).toHaveLength(0);
  });

  // --- parse() ---

  it("parse() returns null for missing file", () => {
    const result = parser.parse({
      filePath: join(tempDir, "nonexistent.json"),
      projectDir: "gemini/hash1",
      sessionId: "hash1-v1",
      mtime: 0,
      size: 0,
    });
    expect(result).toBeNull();
  });

  it("parse() returns null for invalid JSON", () => {
    const chatsDir = join(tempDir, "hash1", "chats");
    mkdirSync(chatsDir, { recursive: true });
    const filePath = join(chatsDir, "checkpoint-bad.json");
    writeFileSync(filePath, "not json");

    const result = parser.parse({
      filePath,
      projectDir: "gemini/hash1",
      sessionId: "hash1-bad",
      mtime: Date.now(),
      size: 100,
    });
    expect(result).toBeNull();
  });

  it("parse() returns null for non-array JSON", () => {
    const chatsDir = join(tempDir, "hash1", "chats");
    mkdirSync(chatsDir, { recursive: true });
    const filePath = join(chatsDir, "checkpoint-obj.json");
    writeFileSync(filePath, JSON.stringify({ not: "array" }));

    const result = parser.parse({
      filePath,
      projectDir: "gemini/hash1",
      sessionId: "hash1-obj",
      mtime: Date.now(),
      size: 100,
    });
    expect(result).toBeNull();
  });

  it("parse() extracts text messages from user and model roles", () => {
    const chatsDir = join(tempDir, "hash1", "chats");
    mkdirSync(chatsDir, { recursive: true });
    const filePath = join(chatsDir, "checkpoint-v1.json");

    const messages = [
      { role: "user", parts: [{ text: "How do I sort an array?" }] },
      { role: "model", parts: [{ text: "You can use Array.sort():\n```js\narr.sort()\n```" }] },
    ];
    writeFileSync(filePath, JSON.stringify(messages));

    const result = parser.parse({
      filePath,
      projectDir: "gemini/hash1",
      sessionId: "hash1-v1",
      mtime: Date.now(),
      size: 100,
    });

    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(2);
    expect(result!.messages[0].role).toBe("user");
    expect(result!.messages[0].text).toBe("How do I sort an array?");
    expect(result!.messages[1].role).toBe("assistant");
    expect(result!.messages[1].hasCode).toBe(true);
    expect(result!.tool).toBe("gemini-cli");
  });

  it("parse() handles functionCall parts", () => {
    const chatsDir = join(tempDir, "hash1", "chats");
    mkdirSync(chatsDir, { recursive: true });
    const filePath = join(chatsDir, "checkpoint-tools.json");

    const messages = [
      { role: "user", parts: [{ text: "Read the config file" }] },
      {
        role: "model",
        parts: [
          { text: "Let me read that file." },
          { functionCall: { name: "read_file", args: { path: "config.json" } } },
        ],
      },
    ];
    writeFileSync(filePath, JSON.stringify(messages));

    const result = parser.parse({
      filePath,
      projectDir: "gemini/hash1",
      sessionId: "hash1-tools",
      mtime: Date.now(),
      size: 100,
    });

    expect(result).not.toBeNull();
    expect(result!.messages[1].toolNames).toEqual(["read_file"]);
    expect(result!.messages[1].toolInputSnippets.length).toBeGreaterThan(0);
    expect(result!.messages[1].text).toContain("[tool: read_file]");
  });

  it("parse() handles functionResponse parts", () => {
    const chatsDir = join(tempDir, "hash1", "chats");
    mkdirSync(chatsDir, { recursive: true });
    const filePath = join(chatsDir, "checkpoint-resp.json");

    const messages = [
      {
        role: "user",
        parts: [
          { functionResponse: { name: "read_file", response: { content: "file contents here" } } },
        ],
      },
    ];
    writeFileSync(filePath, JSON.stringify(messages));

    const result = parser.parse({
      filePath,
      projectDir: "gemini/hash1",
      sessionId: "hash1-resp",
      mtime: Date.now(),
      size: 100,
    });

    expect(result).not.toBeNull();
    expect(result!.messages[0].text).toContain("[tool result: read_file]");
  });

  it("parse() returns null for empty conversation array", () => {
    const chatsDir = join(tempDir, "hash1", "chats");
    mkdirSync(chatsDir, { recursive: true });
    const filePath = join(chatsDir, "checkpoint-empty.json");
    writeFileSync(filePath, "[]");

    const result = parser.parse({
      filePath,
      projectDir: "gemini/hash1",
      sessionId: "hash1-empty",
      mtime: Date.now(),
      size: 2,
    });

    expect(result).toBeNull();
  });

  it("parse() skips messages without parts array", () => {
    const chatsDir = join(tempDir, "hash1", "chats");
    mkdirSync(chatsDir, { recursive: true });
    const filePath = join(chatsDir, "checkpoint-noparts.json");

    const messages = [
      { role: "user" },
      { role: "user", parts: [{ text: "Valid message" }] },
      { role: "model", parts: "not an array" },
    ];
    writeFileSync(filePath, JSON.stringify(messages));

    const result = parser.parse({
      filePath,
      projectDir: "gemini/hash1",
      sessionId: "hash1-noparts",
      mtime: Date.now(),
      size: 100,
    });

    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(1);
    expect(result!.messages[0].text).toBe("Valid message");
  });

  // --- Timestamp extraction ---

  it("parse() extracts startTime and endTime from createTime fields", () => {
    const chatsDir = join(tempDir, "hash1", "chats");
    mkdirSync(chatsDir, { recursive: true });
    const filePath = join(chatsDir, "checkpoint-ts.json");

    const messages = [
      { role: "user", parts: [{ text: "Hello" }], createTime: "2026-03-05T14:30:00Z" },
      { role: "model", parts: [{ text: "Hi there!" }], createTime: "2026-03-05T14:30:15Z" },
      { role: "user", parts: [{ text: "Thanks" }], createTime: "2026-03-05T14:32:00Z" },
    ];
    writeFileSync(filePath, JSON.stringify(messages));

    const result = parser.parse({
      filePath,
      projectDir: "gemini/hash1",
      sessionId: "hash1-ts",
      mtime: Date.now(),
      size: 100,
    });

    expect(result).not.toBeNull();
    expect(result!.startTime).toBe(new Date("2026-03-05T14:30:00Z").getTime());
    expect(result!.endTime).toBe(new Date("2026-03-05T14:32:00Z").getTime());
  });

  it("parse() populates per-message timestamps from createTime", () => {
    const chatsDir = join(tempDir, "hash1", "chats");
    mkdirSync(chatsDir, { recursive: true });
    const filePath = join(chatsDir, "checkpoint-msgts.json");

    const messages = [
      { role: "user", parts: [{ text: "Hello" }], createTime: "2026-03-05T14:30:00Z" },
      { role: "model", parts: [{ text: "Hi!" }], createTime: "2026-03-05T14:30:10Z" },
    ];
    writeFileSync(filePath, JSON.stringify(messages));

    const result = parser.parse({
      filePath,
      projectDir: "gemini/hash1",
      sessionId: "hash1-msgts",
      mtime: Date.now(),
      size: 100,
    });

    expect(result).not.toBeNull();
    expect(result!.messages[0].timestamp).toBe("2026-03-05T14:30:00Z");
    expect(result!.messages[1].timestamp).toBe("2026-03-05T14:30:10Z");
  });

  it("parse() falls back to file mtime when no createTime fields exist", () => {
    const chatsDir = join(tempDir, "hash1", "chats");
    mkdirSync(chatsDir, { recursive: true });
    const filePath = join(chatsDir, "checkpoint-nomtime.json");

    const messages = [
      { role: "user", parts: [{ text: "Hello" }] },
      { role: "model", parts: [{ text: "Hi!" }] },
      { role: "user", parts: [{ text: "Bye" }] },
    ];
    writeFileSync(filePath, JSON.stringify(messages));

    const mtime = 1700000000000;
    const result = parser.parse({
      filePath,
      projectDir: "gemini/hash1",
      sessionId: "hash1-nomtime",
      mtime,
      size: 100,
    });

    expect(result).not.toBeNull();
    // endTime = mtime, startTime = mtime - (messageCount * 30000)
    expect(result!.endTime).toBe(mtime);
    expect(result!.startTime).toBe(mtime - (3 * 30_000));
    // Per-message timestamps remain empty when no createTime
    expect(result!.messages[0].timestamp).toBe("");
  });

  it("parse() ignores invalid createTime strings", () => {
    const chatsDir = join(tempDir, "hash1", "chats");
    mkdirSync(chatsDir, { recursive: true });
    const filePath = join(chatsDir, "checkpoint-badts.json");

    const messages = [
      { role: "user", parts: [{ text: "Hello" }], createTime: "not-a-date" },
      { role: "model", parts: [{ text: "Hi!" }], createTime: "2026-03-05T14:30:00Z" },
    ];
    writeFileSync(filePath, JSON.stringify(messages));

    const result = parser.parse({
      filePath,
      projectDir: "gemini/hash1",
      sessionId: "hash1-badts",
      mtime: 1700000000000,
      size: 100,
    });

    expect(result).not.toBeNull();
    // Only the valid createTime should be used
    expect(result!.startTime).toBe(new Date("2026-03-05T14:30:00Z").getTime());
    expect(result!.endTime).toBe(new Date("2026-03-05T14:30:00Z").getTime());
    // Invalid createTime message has empty timestamp
    expect(result!.messages[0].timestamp).toBe("");
    expect(result!.messages[1].timestamp).toBe("2026-03-05T14:30:00Z");
  });

  it("parse() handles mixed text and tool parts in single message", () => {
    const chatsDir = join(tempDir, "hash1", "chats");
    mkdirSync(chatsDir, { recursive: true });
    const filePath = join(chatsDir, "checkpoint-mixed.json");

    const messages = [
      {
        role: "model",
        parts: [
          { text: "I'll run the tests." },
          { functionCall: { name: "execute_command", args: { command: "npm test" } } },
          { text: "And check the results." },
        ],
      },
    ];
    writeFileSync(filePath, JSON.stringify(messages));

    const result = parser.parse({
      filePath,
      projectDir: "gemini/hash1",
      sessionId: "hash1-mixed",
      mtime: Date.now(),
      size: 100,
    });

    expect(result).not.toBeNull();
    expect(result!.messages[0].text).toContain("I'll run the tests.");
    expect(result!.messages[0].text).toContain("[tool: execute_command]");
    expect(result!.messages[0].text).toContain("And check the results.");
    expect(result!.messages[0].toolNames).toEqual(["execute_command"]);
  });
});
