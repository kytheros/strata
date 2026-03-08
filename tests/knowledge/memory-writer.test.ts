import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { tmpdir } from "os";
import {
  writeLearningsToMemory,
  filterLearningsForProject,
  getMemoryWritePath,
  migrateLegacyMarkers,
} from "../../src/knowledge/memory-writer.js";
import type { KnowledgeEntry } from "../../src/knowledge/knowledge-store.js";

// Override CONFIG for tests
import { CONFIG } from "../../src/config.js";

function makeLearning(
  overrides: Partial<KnowledgeEntry> = {}
): KnowledgeEntry {
  return {
    id: Math.random().toString(36).slice(2),
    type: "learning",
    project: "test-project",
    sessionId: "_synthesized",
    timestamp: Date.now(),
    summary: "Pin Docker image versions to avoid build failures",
    details: "Synthesized from 3 entries",
    tags: ["docker"],
    relatedFiles: [],
    occurrences: 3,
    projectCount: 2,
    ...overrides,
  };
}

describe("getMemoryWritePath", () => {
  it("should return Claude Code path for claude-code tool", () => {
    const result = getMemoryWritePath("claude-code", "-Users-mike-dev-myproject");
    expect(result).toBe(
      join(CONFIG.claudeDir, "projects", "-Users-mike-dev-myproject", "memory", "MEMORY.md")
    );
  });

  it("should return Gemini global path for gemini-cli tool", () => {
    const result = getMemoryWritePath("gemini-cli", "gemini/abc123");
    expect(result).toBe(join(homedir(), ".gemini", "memory", "MEMORY.md"));
  });

  it("should return Codex global path for codex-cli tool", () => {
    const result = getMemoryWritePath("codex-cli", "codex/session1");
    expect(result).toBe(join(homedir(), ".codex", "memory", "MEMORY.md"));
  });

  it("should return Cline globalStorage path for cline tool", () => {
    const result = getMemoryWritePath("cline", "cline/task1");
    expect(result).not.toBeNull();
    expect(result!).toContain("saoudrizwan.claude-dev");
    expect(result!.endsWith(join("memory", "MEMORY.md"))).toBe(true);
  });

  it("should return null for unknown tools", () => {
    expect(getMemoryWritePath("unknown-tool", "foo")).toBeNull();
    expect(getMemoryWritePath("cursor", "bar")).toBeNull();
    expect(getMemoryWritePath("", "baz")).toBeNull();
  });
});

describe("migrateLegacyMarkers", () => {
  it("should replace old markers with new ones", () => {
    const content = [
      "# My Notes",
      "",
      "## Learnings (auto-managed by ClaudeHistoryMCP)",
      "<!-- BEGIN CLAUDE_HISTORY_LEARNINGS -->",
      "- Some learning",
      "<!-- END CLAUDE_HISTORY_LEARNINGS -->",
    ].join("\n");

    const migrated = migrateLegacyMarkers(content);
    expect(migrated).toContain("<!-- BEGIN STRATA_LEARNINGS -->");
    expect(migrated).toContain("<!-- END STRATA_LEARNINGS -->");
    expect(migrated).toContain("## Learnings (auto-managed by Strata)");
    expect(migrated).not.toContain("CLAUDE_HISTORY_LEARNINGS");
    expect(migrated).not.toContain("ClaudeHistoryMCP");
  });

  it("should return content unchanged if no legacy markers", () => {
    const content = "# Just some notes\n\nNo markers here.\n";
    expect(migrateLegacyMarkers(content)).toBe(content);
  });

  it("should handle content with only partial legacy markers", () => {
    const content = "<!-- BEGIN CLAUDE_HISTORY_LEARNINGS -->\n- learning\n";
    const migrated = migrateLegacyMarkers(content);
    expect(migrated).toContain("<!-- BEGIN STRATA_LEARNINGS -->");
    // END marker not present, should not add it
    expect(migrated).not.toContain("<!-- END STRATA_LEARNINGS -->");
  });
});

describe("writeLearningsToMemory", () => {
  let testDir: string;
  let originalClaudeDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `claude-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    originalClaudeDir = (CONFIG as { claudeDir: string }).claudeDir;
    (CONFIG as { claudeDir: string }).claudeDir = testDir;
  });

  afterEach(() => {
    (CONFIG as { claudeDir: string }).claudeDir = originalClaudeDir;
    rmSync(testDir, { recursive: true, force: true });
  });

  it("should create MEMORY.md with managed section using new markers", () => {
    const learnings = [makeLearning()];
    writeLearningsToMemory("test-project", learnings);

    const memoryFile = join(testDir, "projects", "test-project", "memory", "MEMORY.md");
    expect(existsSync(memoryFile)).toBe(true);

    const content = readFileSync(memoryFile, "utf-8");
    expect(content).toContain("<!-- BEGIN STRATA_LEARNINGS -->");
    expect(content).toContain("<!-- END STRATA_LEARNINGS -->");
    expect(content).toContain("Pin Docker image versions");
    expect(content).toContain("## Learnings (auto-managed by Strata)");
  });

  it("should preserve user content when updating managed section", () => {
    const memoryDir = join(testDir, "projects", "test-project", "memory");
    mkdirSync(memoryDir, { recursive: true });
    const memoryFile = join(memoryDir, "MEMORY.md");

    // Write user content with NEW markers
    writeFileSync(
      memoryFile,
      "# My Notes\n\nThis is my custom content.\n\n## Learnings (auto-managed by Strata)\n<!-- BEGIN STRATA_LEARNINGS -->\n- Old learning\n<!-- END STRATA_LEARNINGS -->\n"
    );

    const learnings = [
      makeLearning({ summary: "New learning about Docker" }),
    ];
    writeLearningsToMemory("test-project", learnings);

    const content = readFileSync(memoryFile, "utf-8");
    expect(content).toContain("# My Notes");
    expect(content).toContain("This is my custom content.");
    expect(content).toContain("New learning about Docker");
    expect(content).not.toContain("Old learning");
  });

  it("should migrate old markers when updating existing file with legacy markers", () => {
    const memoryDir = join(testDir, "projects", "test-project", "memory");
    mkdirSync(memoryDir, { recursive: true });
    const memoryFile = join(memoryDir, "MEMORY.md");

    // Write with OLD markers (simulating legacy file)
    writeFileSync(
      memoryFile,
      "# My Notes\n\n## Learnings (auto-managed by ClaudeHistoryMCP)\n<!-- BEGIN CLAUDE_HISTORY_LEARNINGS -->\n- Old learning\n<!-- END CLAUDE_HISTORY_LEARNINGS -->\n"
    );

    const learnings = [
      makeLearning({ summary: "Fresh learning" }),
    ];
    writeLearningsToMemory("test-project", learnings);

    const content = readFileSync(memoryFile, "utf-8");
    // Should have new markers
    expect(content).toContain("<!-- BEGIN STRATA_LEARNINGS -->");
    expect(content).toContain("<!-- END STRATA_LEARNINGS -->");
    expect(content).toContain("## Learnings (auto-managed by Strata)");
    // Should NOT have old markers
    expect(content).not.toContain("CLAUDE_HISTORY_LEARNINGS");
    expect(content).not.toContain("ClaudeHistoryMCP");
    // Should have the new learning
    expect(content).toContain("Fresh learning");
    expect(content).not.toContain("Old learning");
  });

  it("should not write if no learnings provided", () => {
    writeLearningsToMemory("test-project", []);

    const memoryFile = join(testDir, "projects", "test-project", "memory", "MEMORY.md");
    expect(existsSync(memoryFile)).toBe(false);
  });

  it("should limit learnings to maxLearningsPerProject", () => {
    const learnings = Array.from({ length: 15 }, (_, i) =>
      makeLearning({ summary: `Learning number ${i}` })
    );
    writeLearningsToMemory("test-project", learnings);

    const memoryFile = join(testDir, "projects", "test-project", "memory", "MEMORY.md");
    const content = readFileSync(memoryFile, "utf-8");

    // Should contain max 10 learnings (CONFIG.learning.maxLearningsPerProject)
    const learningLines = content
      .split("\n")
      .filter((l) => l.startsWith("- Learning number"));
    expect(learningLines.length).toBe(10);
  });

  it("should handle content after the managed section", () => {
    const memoryDir = join(testDir, "projects", "test-project", "memory");
    mkdirSync(memoryDir, { recursive: true });
    const memoryFile = join(memoryDir, "MEMORY.md");

    writeFileSync(
      memoryFile,
      "# Before\n\n## Learnings (auto-managed by Strata)\n<!-- BEGIN STRATA_LEARNINGS -->\n- Old\n<!-- END STRATA_LEARNINGS -->\n\n## After\n\nMore content here.\n"
    );

    writeLearningsToMemory("test-project", [
      makeLearning({ summary: "Updated learning" }),
    ]);

    const content = readFileSync(memoryFile, "utf-8");
    expect(content).toContain("# Before");
    expect(content).toContain("Updated learning");
    expect(content).toContain("## After");
    expect(content).toContain("More content here.");
    expect(content).not.toContain("Old");
  });

  it("should default to claude-code tool when tool param is omitted", () => {
    const learnings = [makeLearning()];
    // No tool param — should default to claude-code
    writeLearningsToMemory("test-project", learnings);

    const memoryFile = join(testDir, "projects", "test-project", "memory", "MEMORY.md");
    expect(existsSync(memoryFile)).toBe(true);
  });

  it("should skip writing for unknown tools", () => {
    const learnings = [makeLearning()];
    writeLearningsToMemory("test-project", learnings, "unknown-tool");

    // No file should be created anywhere for unknown tools
    const claudeMemory = join(testDir, "projects", "test-project", "memory", "MEMORY.md");
    expect(existsSync(claudeMemory)).toBe(false);
  });

  it("should write to gemini memory path for gemini-cli tool", () => {
    // Create a temp gemini dir and override homedir behavior
    const geminiMemDir = join(testDir, ".gemini", "memory");
    // We need to test the actual path logic, but since getMemoryWritePath
    // uses homedir(), we test the path computation separately.
    // Here we test that the function doesn't error on a valid tool.
    const path = getMemoryWritePath("gemini-cli", "any-project");
    expect(path).toBe(join(homedir(), ".gemini", "memory", "MEMORY.md"));
  });

  it("should write to codex memory path for codex-cli tool", () => {
    const path = getMemoryWritePath("codex-cli", "any-project");
    expect(path).toBe(join(homedir(), ".codex", "memory", "MEMORY.md"));
  });
});

describe("filterLearningsForProject", () => {
  it("should filter by matching tags", () => {
    const learnings = [
      makeLearning({ tags: ["docker"], occurrences: 3 }),
      makeLearning({ tags: ["python"], occurrences: 3 }),
    ];
    const filtered = filterLearningsForProject(learnings, ["docker"]);
    expect(filtered.length).toBe(1);
    expect(filtered[0].tags).toContain("docker");
  });

  it("should always include high-occurrence learnings", () => {
    const learnings = [
      makeLearning({ tags: ["python"], occurrences: 5 }),
      makeLearning({ tags: ["python"], occurrences: 2 }),
    ];
    const filtered = filterLearningsForProject(learnings, ["docker"]);
    expect(filtered.length).toBe(1);
    expect(filtered[0].occurrences).toBe(5);
  });

  it("should return all if no project tags", () => {
    const learnings = [
      makeLearning({ tags: ["docker"] }),
      makeLearning({ tags: ["python"] }),
    ];
    const filtered = filterLearningsForProject(learnings, []);
    expect(filtered.length).toBe(2);
  });
});
