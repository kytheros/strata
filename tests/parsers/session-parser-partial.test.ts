import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parsePartial } from "../../src/parsers/session-parser.js";

function makeLine(type: string, role: string, content: string): string {
  return JSON.stringify({
    type,
    message: { role, content },
    uuid: `uuid-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    cwd: "/test",
  });
}

describe("parsePartial", () => {
  let tmpDir: string;
  let testFile: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `partial-parse-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    testFile = join(tmpDir, "session.jsonl");
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup best effort
    }
  });

  it("parses all lines from offset 0", () => {
    const lines = [
      makeLine("user", "user", "Hello world"),
      makeLine("assistant", "assistant", "Hi there"),
    ];
    writeFileSync(testFile, lines.join("\n") + "\n");

    const result = parsePartial(testFile, 0);
    expect(result.messages.length).toBe(2);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[1].role).toBe("assistant");
    expect(result.totalLines).toBeGreaterThan(0);
  });

  it("parses only new lines from offset", () => {
    const lines = [
      makeLine("user", "user", "First message"),
      makeLine("assistant", "assistant", "First response"),
      makeLine("user", "user", "Second message"),
    ];
    writeFileSync(testFile, lines.join("\n") + "\n");

    // Parse from line 2 (skip first two lines)
    const result = parsePartial(testFile, 2);
    expect(result.messages.length).toBe(1);
    expect(result.messages[0].text).toContain("Second message");
  });

  it("returns empty for non-existent file", () => {
    const result = parsePartial("/nonexistent/file.jsonl", 0);
    expect(result.messages).toEqual([]);
    expect(result.linesRead).toBe(0);
    expect(result.totalLines).toBe(0);
  });

  it("returns empty when offset is at end of file", () => {
    const lines = [
      makeLine("user", "user", "Only message"),
    ];
    writeFileSync(testFile, lines.join("\n") + "\n");

    // First read to get totalLines
    const first = parsePartial(testFile, 0);

    // Read from end
    const result = parsePartial(testFile, first.totalLines);
    expect(result.messages.length).toBe(0);
    expect(result.linesRead).toBe(0);
  });

  it("skips progress and snapshot lines", () => {
    const lines = [
      makeLine("user", "user", "A question"),
      JSON.stringify({ type: "progress", data: "building..." }),
      JSON.stringify({ type: "file-history-snapshot", files: [] }),
      makeLine("assistant", "assistant", "An answer"),
    ];
    writeFileSync(testFile, lines.join("\n") + "\n");

    const result = parsePartial(testFile, 0);
    expect(result.messages.length).toBe(2);
  });

  it("skips malformed JSON lines", () => {
    const content = [
      makeLine("user", "user", "Valid message"),
      "not valid json {{{",
      makeLine("assistant", "assistant", "Another valid message"),
    ].join("\n") + "\n";
    writeFileSync(testFile, content);

    const result = parsePartial(testFile, 0);
    expect(result.messages.length).toBe(2);
  });
});
