/**
 * Tests for `strata init --gemini` (runInitGemini).
 *
 * Tests the init function with a mocked filesystem, verifying:
 * - File creation (skills, commands, GEMINI.md, settings.json)
 * - Idempotency (second run skips existing files)
 * - Force flag (overwrites existing files)
 * - Settings.json merging behavior
 * - Malformed settings.json handling
 * - GEMINI.md append/skip logic
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readdirSync,
} from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";

/** Create a unique temp directory per test */
function makeTempDir(label: string): string {
  const dir = join(
    tmpdir(),
    `strata-init-gemini-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Import and call runInitGemini with mocked home directory and execSync.
 *
 * We need to mock:
 * - os.homedir() -> point to our temp home dir (for ~/.gemini/settings.json)
 * - child_process.execSync -> pretend gemini CLI is installed
 *
 * Since init-gemini.ts imports these at module level, we use vi.mock.
 */

// Store the mock home dir for each test
let mockHomeDir: string;
let mockProjectDir: string;

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    homedir: () => mockHomeDir,
  };
});

vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    execSync: (cmd: string, ...args: unknown[]) => {
      if (typeof cmd === "string" && cmd.includes("gemini --version")) {
        return "Gemini CLI v1.0.0\n";
      }
      // Fall through to actual for other commands
      return (actual.execSync as Function)(cmd, ...args);
    },
  };
});

describe("strata init --gemini", () => {
  beforeEach(() => {
    mockHomeDir = makeTempDir("home");
    mockProjectDir = makeTempDir("project");

    // Create ~/.gemini/ directory (prerequisite check expects it)
    mkdirSync(join(mockHomeDir, ".gemini"), { recursive: true });

    // Suppress console output during tests
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();

    for (const dir of [mockHomeDir, mockProjectDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Cleanup best effort
      }
    }
  });

  async function runInit(opts: { force?: boolean; global?: boolean } = {}) {
    // Dynamic import to pick up the mocked modules
    const { runInitGemini } = await import("../../src/cli/init-gemini.js");
    await runInitGemini({
      cwd: mockProjectDir,
      force: opts.force ?? false,
      global: opts.global ?? false,
    });
  }

  // ── File Creation ──────────────────────────────────────────────────

  it("creates .agents/skills/ with all four SKILL.md files", async () => {
    await runInit();

    const skillNames = ["recall", "remember", "gaps", "strata-status"];
    for (const skill of skillNames) {
      const skillFile = join(mockProjectDir, ".agents", "skills", skill, "SKILL.md");
      expect(existsSync(skillFile), `Expected ${skill}/SKILL.md to exist`).toBe(true);

      const content = readFileSync(skillFile, "utf-8");
      // SKILL.md should have YAML frontmatter with name and description
      expect(content).toContain("---");
      expect(content).toContain(`name: ${skill}`);
      expect(content).toContain("description:");
    }
  });

  it("creates .gemini/commands/ with all four TOML files", async () => {
    await runInit();

    const commands = ["recall.toml", "remember.toml", "gaps.toml", "strata-status.toml"];
    for (const cmd of commands) {
      const cmdFile = join(mockProjectDir, ".gemini", "commands", cmd);
      expect(existsSync(cmdFile), `Expected ${cmd} to exist`).toBe(true);
    }
  });

  it("creates GEMINI.md from template", async () => {
    await runInit();

    const geminiMd = join(mockProjectDir, "GEMINI.md");
    expect(existsSync(geminiMd)).toBe(true);

    const content = readFileSync(geminiMd, "utf-8");
    expect(content).toContain("## Strata Memory");
  });

  it("creates GEMINI-strata-tools.md", async () => {
    await runInit();

    const toolsMd = join(mockProjectDir, "GEMINI-strata-tools.md");
    expect(existsSync(toolsMd)).toBe(true);
  });

  // ── Settings.json ──────────────────────────────────────────────────

  it("writes MCP config to settings.json", async () => {
    await runInit();

    const settingsFile = join(mockHomeDir, ".gemini", "settings.json");
    expect(existsSync(settingsFile)).toBe(true);

    const settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
    expect(settings.mcpServers).toBeDefined();
    expect(settings.mcpServers["strata-mcp"]).toBeDefined();
    expect(settings.mcpServers["strata-mcp"].command).toBe("npx");
    expect(settings.mcpServers["strata-mcp"].args).toContain("strata-mcp");
  });

  it("writes hooks to settings.json", async () => {
    await runInit();

    const settingsFile = join(mockHomeDir, ".gemini", "settings.json");
    const settings = JSON.parse(readFileSync(settingsFile, "utf-8"));

    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(Array.isArray(settings.hooks.SessionStart)).toBe(true);

    const matchers = settings.hooks.SessionStart.map(
      (entry: { matcher: string }) => entry.matcher
    );
    expect(matchers).toContain("startup");
    expect(matchers).toContain("resume");

    // Each hook entry should have the strata hook
    for (const entry of settings.hooks.SessionStart) {
      const hookNames = entry.hooks.map((h: { name: string }) => h.name);
      const hasStrata = hookNames.some((n: string) => n.startsWith("strata-session"));
      expect(hasStrata, `Matcher "${entry.matcher}" should have strata hook`).toBe(true);
    }
  });

  it("merges into existing settings.json without overwriting other keys", async () => {
    // Pre-populate settings.json with existing content
    const settingsFile = join(mockHomeDir, ".gemini", "settings.json");
    const existing = {
      theme: "dark",
      mcpServers: {
        "other-mcp": { command: "other" },
      },
      customSetting: true,
    };
    writeFileSync(settingsFile, JSON.stringify(existing, null, 2));

    await runInit();

    const settings = JSON.parse(readFileSync(settingsFile, "utf-8"));

    // Existing keys should be preserved
    expect(settings.theme).toBe("dark");
    expect(settings.customSetting).toBe(true);
    expect(settings.mcpServers["other-mcp"]).toBeDefined();

    // Strata MCP should be added alongside existing
    expect(settings.mcpServers["strata-mcp"]).toBeDefined();
  });

  it("handles malformed settings.json gracefully", async () => {
    // Write invalid JSON to settings.json
    const settingsFile = join(mockHomeDir, ".gemini", "settings.json");
    writeFileSync(settingsFile, "{ this is not valid json !!!");

    // Should not throw — creates fresh settings
    await runInit();

    const settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
    expect(settings.mcpServers["strata-mcp"]).toBeDefined();
  });

  // ── Idempotency ────────────────────────────────────────────────────

  it("is idempotent (second run skips existing files)", async () => {
    // First run: creates everything
    await runInit();

    // Modify a skill file to verify it is NOT overwritten
    const recallFile = join(mockProjectDir, ".agents", "skills", "recall", "SKILL.md");
    const originalContent = readFileSync(recallFile, "utf-8");
    writeFileSync(recallFile, originalContent + "\n# User customization");

    // Second run: should skip existing files
    await runInit();

    // The customization should still be there (not overwritten)
    const afterSecondRun = readFileSync(recallFile, "utf-8");
    expect(afterSecondRun).toContain("# User customization");
  });

  // ── Force Flag ─────────────────────────────────────────────────────

  it("force flag overwrites all files", async () => {
    // First run: creates everything
    await runInit();

    // Modify a skill file
    const recallFile = join(mockProjectDir, ".agents", "skills", "recall", "SKILL.md");
    writeFileSync(recallFile, "# Custom content that should be replaced");

    // Second run with force: should overwrite
    await runInit({ force: true });

    const content = readFileSync(recallFile, "utf-8");
    expect(content).not.toContain("Custom content that should be replaced");
    expect(content).toContain("name: recall");
  });

  // ── GEMINI.md ──────────────────────────────────────────────────────

  it("appends Strata section to existing GEMINI.md", async () => {
    // Create a pre-existing GEMINI.md without Strata section
    const geminiMdPath = join(mockProjectDir, "GEMINI.md");
    writeFileSync(geminiMdPath, "# My Project\n\nExisting project docs.\n");

    await runInit();

    const content = readFileSync(geminiMdPath, "utf-8");
    expect(content).toContain("# My Project");
    expect(content).toContain("Existing project docs.");
    expect(content).toContain("## Strata Memory");
  });

  it("skips if Strata section already in GEMINI.md", async () => {
    // Create GEMINI.md that already has Strata section
    const geminiMdPath = join(mockProjectDir, "GEMINI.md");
    const existingContent = "# My Project\n\n## Strata Memory\n\nAlready configured.\n";
    writeFileSync(geminiMdPath, existingContent);

    await runInit();

    const content = readFileSync(geminiMdPath, "utf-8");
    // Should not duplicate the section
    const strataCount = (content.match(/## Strata Memory/g) || []).length;
    expect(strataCount).toBe(1);
  });

  // ── SKILL.md Validation ────────────────────────────────────────────

  it("generated SKILL.md files have valid YAML frontmatter", async () => {
    await runInit();

    const skillNames = ["recall", "remember", "gaps", "strata-status"];
    for (const skill of skillNames) {
      const skillFile = join(mockProjectDir, ".agents", "skills", skill, "SKILL.md");
      const content = readFileSync(skillFile, "utf-8");

      // Should start with --- and have closing ---
      const lines = content.split("\n");
      expect(lines[0]).toBe("---");
      const closingIdx = lines.indexOf("---", 1);
      expect(closingIdx).toBeGreaterThan(0);

      // Extract frontmatter
      const frontmatter = lines.slice(1, closingIdx).join("\n");
      expect(frontmatter).toContain("name:");
      expect(frontmatter).toContain("description:");

      // Name in frontmatter should match directory name
      const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
      expect(nameMatch, `SKILL.md for ${skill} should have name field`).not.toBeNull();
      expect(nameMatch![1].trim()).toBe(skill);
    }
  });

  // ── Data Directory ─────────────────────────────────────────────────

  it("creates ~/.strata/ data directory", async () => {
    await runInit();

    const strataDir = join(mockHomeDir, ".strata");
    expect(existsSync(strataDir)).toBe(true);
  });
});
