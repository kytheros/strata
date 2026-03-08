/**
 * Tests for AiderParser — Aider conversation parser.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AiderParser, parseAiderMarkdown } from "../../src/parsers/aider-parser.js";

function makeTempDir(): string {
  const dir = join(tmpdir(), `aider-parser-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const SAMPLE_HISTORY = `#### How do I set up a CI pipeline for this project?

Here's how to configure GitHub Actions for CI:

\`\`\`yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
\`\`\`

#### Can you add a lint step too?

Sure, I'll add ESLint to the pipeline:

\`\`\`yaml
      - run: npm run lint
\`\`\`

#### Fix the TypeScript compilation error in src/index.ts

I found the issue. The function signature was missing a return type:

\`\`\`typescript
src/index.ts
<<<<<<< SEARCH
function main() {
=======
function main(): void {
>>>>>>> REPLACE
\`\`\`
`;

describe("AiderParser", () => {
  let tempDir: string;
  let parser: AiderParser;

  beforeEach(() => {
    tempDir = makeTempDir();
    parser = new AiderParser([tempDir]);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // --- detect() ---

  it("detect() returns true when .aider.chat.history.md exists", () => {
    writeFileSync(join(tempDir, ".aider.chat.history.md"), SAMPLE_HISTORY);
    expect(parser.detect()).toBe(true);
  });

  it("detect() returns true when history exists in subdirectory", () => {
    const subDir = join(tempDir, "my-project");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, ".aider.chat.history.md"), SAMPLE_HISTORY);
    expect(parser.detect()).toBe(true);
  });

  it("detect() returns false when no history files exist", () => {
    expect(parser.detect()).toBe(false);
  });

  it("detect() returns false for nonexistent directory", () => {
    const missing = new AiderParser([join(tempDir, "nonexistent")]);
    expect(missing.detect()).toBe(false);
  });

  // --- discover() ---

  it("discover() returns empty array when no files exist", () => {
    expect(parser.discover()).toEqual([]);
  });

  it("discover() finds .aider.chat.history.md in root and subdirectories", () => {
    writeFileSync(join(tempDir, ".aider.chat.history.md"), SAMPLE_HISTORY);
    const subDir = join(tempDir, "project-a");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, ".aider.chat.history.md"), SAMPLE_HISTORY);

    const files = parser.discover();
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.filePath.endsWith(".aider.chat.history.md"))).toBe(true);
  });

  it("discover() deduplicates files found from multiple scan paths", () => {
    writeFileSync(join(tempDir, ".aider.chat.history.md"), SAMPLE_HISTORY);
    // Create parser that scans the same dir twice
    const dupeParser = new AiderParser([tempDir, tempDir]);
    const files = dupeParser.discover();
    expect(files).toHaveLength(1);
  });

  it("discover() includes size and mtime", () => {
    writeFileSync(join(tempDir, ".aider.chat.history.md"), SAMPLE_HISTORY);
    const files = parser.discover();
    expect(files[0].size).toBeGreaterThan(0);
    expect(files[0].mtime).toBeGreaterThan(0);
  });

  // --- parse() ---

  it("parse() returns null for missing file", () => {
    const result = parser.parse({
      filePath: join(tempDir, "nonexistent.md"),
      projectDir: "test",
      sessionId: "missing",
      mtime: 0,
      size: 0,
    });
    expect(result).toBeNull();
  });

  it("parse() returns null for empty file", () => {
    const filePath = join(tempDir, ".aider.chat.history.md");
    writeFileSync(filePath, "");
    const result = parser.parse({
      filePath,
      projectDir: "test",
      sessionId: "empty",
      mtime: Date.now(),
      size: 0,
    });
    expect(result).toBeNull();
  });

  it("parse() extracts user and assistant messages from markdown", () => {
    const filePath = join(tempDir, ".aider.chat.history.md");
    writeFileSync(filePath, SAMPLE_HISTORY);

    const result = parser.parse({
      filePath,
      projectDir: "my-project",
      sessionId: "aider-test1",
      mtime: Date.now(),
      size: SAMPLE_HISTORY.length,
    });

    expect(result).not.toBeNull();
    expect(result!.tool).toBe("aider");
    expect(result!.sessionId).toBe("aider-test1");
    expect(result!.project).toBe("my-project");

    // 3 user messages + 3 assistant responses = 6
    expect(result!.messages.length).toBe(6);

    // Check alternating roles
    expect(result!.messages[0].role).toBe("user");
    expect(result!.messages[0].text).toBe("How do I set up a CI pipeline for this project?");
    expect(result!.messages[1].role).toBe("assistant");
    expect(result!.messages[1].hasCode).toBe(true);
  });

  it("parse() detects Edit tool from SEARCH/REPLACE blocks", () => {
    const filePath = join(tempDir, ".aider.chat.history.md");
    writeFileSync(filePath, SAMPLE_HISTORY);

    const result = parser.parse({
      filePath,
      projectDir: "my-project",
      sessionId: "aider-tools",
      mtime: Date.now(),
      size: SAMPLE_HISTORY.length,
    });

    expect(result).not.toBeNull();
    // The last assistant message contains SEARCH/REPLACE
    const lastAssistant = result!.messages.filter((m) => m.role === "assistant").pop()!;
    expect(lastAssistant.toolNames).toContain("Edit");
  });

  it("parse() sets cwd to parent directory of history file", () => {
    const subDir = join(tempDir, "my-project");
    mkdirSync(subDir, { recursive: true });
    const filePath = join(subDir, ".aider.chat.history.md");
    writeFileSync(filePath, SAMPLE_HISTORY);

    const result = parser.parse({
      filePath,
      projectDir: "my-project",
      sessionId: "aider-cwd",
      mtime: Date.now(),
      size: SAMPLE_HISTORY.length,
    });

    expect(result).not.toBeNull();
    expect(result!.cwd).toBe(subDir);
  });
});

// --- parseAiderMarkdown unit tests ---

describe("parseAiderMarkdown", () => {
  it("parses simple user/assistant pair", () => {
    const input = `#### Hello

Hi there!
`;
    const messages = parseAiderMarkdown(input);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].text).toBe("Hello");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].text).toBe("Hi there!");
  });

  it("handles multiple exchanges", () => {
    const input = `#### First question

First answer

#### Second question

Second answer
`;
    const messages = parseAiderMarkdown(input);
    expect(messages).toHaveLength(4);
    expect(messages[0].text).toBe("First question");
    expect(messages[1].text).toBe("First answer");
    expect(messages[2].text).toBe("Second question");
    expect(messages[3].text).toBe("Second answer");
  });

  it("handles multi-line assistant responses", () => {
    const input = `#### Question

Line 1
Line 2
Line 3
`;
    const messages = parseAiderMarkdown(input);
    expect(messages).toHaveLength(2);
    expect(messages[1].text).toContain("Line 1");
    expect(messages[1].text).toContain("Line 2");
    expect(messages[1].text).toContain("Line 3");
  });

  it("returns empty for content with no #### markers", () => {
    const input = "Just some random text without any markers\n";
    const messages = parseAiderMarkdown(input);
    expect(messages).toEqual([]);
  });

  it("handles user message with no assistant response (trailing)", () => {
    const input = `#### First

Response

#### Trailing question with no response yet
`;
    const messages = parseAiderMarkdown(input);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    // The first pair should be complete
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("detects code blocks", () => {
    const input = "#### Show me code\n\nHere:\n\n```python\nprint('hi')\n```\n";
    const messages = parseAiderMarkdown(input);
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant!.hasCode).toBe(true);
  });

  it("detects bash tool from code blocks", () => {
    const input = "#### Run tests\n\nSure:\n\n```bash\nnpm test\n```\n";
    const messages = parseAiderMarkdown(input);
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant!.toolNames).toContain("Bash");
  });
});
