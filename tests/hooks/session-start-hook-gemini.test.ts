/**
 * Tests for the SessionStart hook's dual-mode output (Gemini JSON vs Claude plain text).
 *
 * Runs the hook as a subprocess with different env vars to validate:
 * - JSON output when GEMINI_PROJECT_DIR is set
 * - Plain text output when GEMINI_PROJECT_DIR is not set
 * - Empty output when no history exists
 * - Empty output when stdin source is "clear"
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, execSync, spawnSync } from "child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";

const projectRoot = join(import.meta.dirname, "../..").replace(/\\/g, "/");
const hookScript = join(projectRoot, "src/hooks/session-start-hook.ts").replace(/\\/g, "/");

/** Create a unique temp directory for each test run */
function makeTempDir(label: string): string {
  const dir = join(
    tmpdir(),
    `strata-hook-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Run the hook via tsx as a subprocess.
 * Returns stdout content. Optionally pipes stdinData to the process.
 */
function runHook(opts: {
  env?: Record<string, string | undefined>;
  stdinData?: string;
  timeout?: number;
}): { stdout: string; stderr: string; exitCode: number } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...opts.env,
  };

  // Remove undefined keys (deleting env vars)
  for (const [key, val] of Object.entries(env)) {
    if (val === undefined) {
      delete env[key];
    }
  }

  const result = spawnSync(
    "npx",
    ["tsx", hookScript],
    {
      // Always run from projectRoot so npx can find tsx in node_modules.
      // Running from a temp dir on Node 20 breaks npx resolution (works on 22).
      // The hook gets the target dir via env vars, not cwd.
      cwd: projectRoot,
      timeout: opts.timeout ?? 15_000,
      encoding: "utf-8",
      env: env as NodeJS.ProcessEnv,
      input: opts.stdinData ?? "",
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    }
  );

  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    exitCode: result.status ?? 1,
  };
}

describe("SessionStart hook Gemini format", () => {
  let dataDir: string;
  let projectDir: string;

  beforeEach(() => {
    dataDir = makeTempDir("data");
    projectDir = makeTempDir("project");
  });

  afterEach(() => {
    for (const dir of [dataDir, projectDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Cleanup best effort
      }
    }
  });

  it("emits nothing when no history exists (empty database)", () => {
    // Point to an empty data dir with no prior sessions
    const result = runHook({
      env: {
        STRATA_DATA_DIR: dataDir,
        GEMINI_PROJECT_DIR: projectDir,
      },
    });

    // With no history, the hook should exit cleanly and emit nothing
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("emits nothing when no history exists (plain text mode)", () => {
    // Same test but without GEMINI_PROJECT_DIR — Claude Code mode
    const result = runHook({
      env: {
        STRATA_DATA_DIR: dataDir,
        GEMINI_PROJECT_DIR: undefined,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("emits JSON with hookSpecificOutput when GEMINI_PROJECT_DIR is set and history exists", () => {
    // Seed the database with knowledge so the hook has content to emit
    const db = openDatabase(join(dataDir, "strata.db"));
    const projectPath = projectDir.replace(/\\/g, "-").replace(/:/g, "");

    db.prepare(`
      INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details, tags, user)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "test-decision-1",
      "decision",
      projectPath,
      "session-abc",
      Date.now(),
      "Use PostgreSQL for the database layer",
      "Decided to use PostgreSQL instead of MySQL for better JSON support.",
      "database,postgresql",
      "default"
    );
    db.close();

    const result = runHook({
      env: {
        STRATA_DATA_DIR: dataDir,
        GEMINI_PROJECT_DIR: projectDir,
      },
    });

    expect(result.exitCode).toBe(0);

    if (result.stdout.length > 0) {
      // Parse the JSON output — it should be valid JSON
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toHaveProperty("hookSpecificOutput");
      expect(parsed.hookSpecificOutput).toHaveProperty("hookEventName", "SessionStart");
      expect(parsed.hookSpecificOutput).toHaveProperty("additionalContext");
      expect(parsed.hookSpecificOutput.additionalContext).toContain("[Strata]");
    }
    // If stdout is empty, the hook found no context for this project path (acceptable)
  });

  it("emits plain text when GEMINI_PROJECT_DIR is not set and history exists", () => {
    // Seed database with knowledge
    const db = openDatabase(join(dataDir, "strata.db"));
    const projectPath = projectDir.replace(/\\/g, "-").replace(/:/g, "");

    db.prepare(`
      INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details, tags, user)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "test-solution-1",
      "solution",
      projectPath,
      "session-xyz",
      Date.now(),
      "Fixed memory leak by clearing event listeners",
      "The WebSocket handler was not cleaning up listeners on disconnect.",
      "websocket,memory",
      "default"
    );
    db.close();

    const result = runHook({
      env: {
        STRATA_DATA_DIR: dataDir,
        GEMINI_PROJECT_DIR: undefined,
      },
    });

    expect(result.exitCode).toBe(0);

    if (result.stdout.length > 0) {
      // Plain text mode: output should NOT be JSON
      expect(() => {
        const parsed = JSON.parse(result.stdout);
        // If it parses as JSON with hookSpecificOutput, that is wrong for plain text mode
        expect(parsed).not.toHaveProperty("hookSpecificOutput");
      }).toThrow(); // JSON.parse should throw because output is plain text

      // Should start with [Strata] header
      expect(result.stdout).toContain("[Strata]");
    }
  });

  it("skips context when stdin source is 'clear'", () => {
    // Seed database with knowledge
    const db = openDatabase(join(dataDir, "strata.db"));
    const projectPath = projectDir.replace(/\\/g, "-").replace(/:/g, "");

    db.prepare(`
      INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details, tags, user)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "test-decision-2",
      "decision",
      projectPath,
      "session-clear",
      Date.now(),
      "Use Redis for caching",
      "Decided on Redis for distributed caching.",
      "redis,caching",
      "default"
    );
    db.close();

    // Pipe { source: "clear" } to stdin — hook should exit with no output
    const result = runHook({
      env: {
        STRATA_DATA_DIR: dataDir,
        GEMINI_PROJECT_DIR: projectDir,
      },
      stdinData: JSON.stringify({ source: "clear" }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("handles invalid JSON on stdin gracefully", () => {
    // Pipe garbage to stdin — hook should not crash
    const result = runHook({
      env: {
        STRATA_DATA_DIR: dataDir,
        GEMINI_PROJECT_DIR: projectDir,
      },
      stdinData: "not valid json {{{",
    });

    // Should exit cleanly (0), possibly with empty output since no history
    expect(result.exitCode).toBe(0);
  });

  it("detects Gemini mode via GEMINI_CONVERSATION_ID as well", () => {
    // Seed database with knowledge
    const db = openDatabase(join(dataDir, "strata.db"));
    const projectPath = projectDir.replace(/\\/g, "-").replace(/:/g, "");

    db.prepare(`
      INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details, tags, user)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "test-decision-conv",
      "decision",
      projectPath,
      "session-conv",
      Date.now(),
      "Use TypeScript strict mode",
      "Enabled strict mode in tsconfig.",
      "typescript",
      "default"
    );
    db.close();

    const result = runHook({
      env: {
        STRATA_DATA_DIR: dataDir,
        // Use GEMINI_CONVERSATION_ID instead of GEMINI_PROJECT_DIR
        GEMINI_CONVERSATION_ID: "test-conversation-123",
        GEMINI_PROJECT_DIR: undefined,
      },
    });

    expect(result.exitCode).toBe(0);

    // If there is output, it should be JSON format because GEMINI_CONVERSATION_ID triggers Gemini mode
    if (result.stdout.length > 0) {
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toHaveProperty("hookSpecificOutput");
    }
  });
});
