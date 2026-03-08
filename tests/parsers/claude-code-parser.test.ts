import { describe, it, expect } from "vitest";
import { ClaudeCodeParser } from "../../src/parsers/claude-code-parser.js";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("ClaudeCodeParser", () => {
  const parser = new ClaudeCodeParser();

  it("should have correct id and name", () => {
    expect(parser.id).toBe("claude-code");
    expect(parser.name).toBe("Claude Code");
  });

  it("should implement ConversationParser interface", () => {
    expect(typeof parser.detect).toBe("function");
    expect(typeof parser.discover).toBe("function");
    expect(typeof parser.parse).toBe("function");
    expect(typeof parser.id).toBe("string");
    expect(typeof parser.name).toBe("string");
  });

  it("detect() should return a boolean", () => {
    const result = parser.detect();
    expect(typeof result).toBe("boolean");
  });

  it("discover() should return an array", () => {
    const result = parser.discover();
    expect(Array.isArray(result)).toBe(true);
  });

  it("discover() results should have required SessionFileInfo fields", () => {
    const files = parser.discover();
    for (const file of files) {
      expect(typeof file.filePath).toBe("string");
      expect(typeof file.projectDir).toBe("string");
      expect(typeof file.sessionId).toBe("string");
      expect(typeof file.mtime).toBe("number");
      expect(typeof file.size).toBe("number");
    }
  });

  describe("parse() with fixture data", () => {
    const fixtureDir = join(tmpdir(), "claude-parser-test-" + Date.now());
    const sessionFile = join(fixtureDir, "test-session.jsonl");

    it("should parse a valid session file and set tool field", () => {
      mkdirSync(fixtureDir, { recursive: true });

      const lines = [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "Hello, help me with Docker" },
          timestamp: "2026-01-01T10:00:00Z",
          uuid: "u1",
          sessionId: "test-session",
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Sure, I can help with Docker." }],
          },
          timestamp: "2026-01-01T10:00:05Z",
          uuid: "a1",
          sessionId: "test-session",
        }),
      ];

      writeFileSync(sessionFile, lines.join("\n"));

      const result = parser.parse({
        filePath: sessionFile,
        projectDir: "test-project",
        sessionId: "test-session",
        mtime: Date.now(),
        size: 500,
      });

      expect(result).not.toBeNull();
      expect(result!.tool).toBe("claude-code");
      expect(result!.sessionId).toBe("test-session");
      expect(result!.project).toBe("test-project");
      expect(result!.messages).toHaveLength(2);
      expect(result!.messages[0].role).toBe("user");
      expect(result!.messages[0].text).toContain("Docker");
      expect(result!.messages[1].role).toBe("assistant");

      // Cleanup
      rmSync(fixtureDir, { recursive: true, force: true });
    });

    it("should return null for non-existent file", () => {
      const result = parser.parse({
        filePath: "/non/existent/path.jsonl",
        projectDir: "proj",
        sessionId: "missing",
        mtime: 0,
        size: 0,
      });

      expect(result).toBeNull();
    });

    it("should return null for empty session file", () => {
      mkdirSync(fixtureDir, { recursive: true });
      writeFileSync(sessionFile, "");

      const result = parser.parse({
        filePath: sessionFile,
        projectDir: "proj",
        sessionId: "empty",
        mtime: Date.now(),
        size: 0,
      });

      expect(result).toBeNull();

      rmSync(fixtureDir, { recursive: true, force: true });
    });
  });
});
