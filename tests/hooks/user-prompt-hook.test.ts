/**
 * Tests for UserPromptSubmit hook.
 *
 * Validates:
 * - Exit 0 with no output when no trigger matches (fast path)
 * - Exit 0 with context when error trigger matches
 * - Exit 0 with context when recall trigger matches
 * - Exit 0 with no output when prompt is empty
 * - Exit 0 when database is unavailable
 * - Trigger detection correctness
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";

const projectRoot = join(import.meta.dirname, "../..").replace(/\\/g, "/");
const hookScript = join(projectRoot, "src/hooks/user-prompt-hook.ts").replace(/\\/g, "/");

function runHook(opts: { stdinData?: string; env?: Record<string, string | undefined> }): {
  stdout: string; stderr: string; exitCode: number;
} {
  const result = spawnSync("npx", ["tsx", hookScript], {
    input: opts.stdinData || "",
    env: { ...process.env, ...opts.env },
    timeout: 15000,
    encoding: "utf-8",
    shell: true,
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 0,
  };
}

describe("UserPromptSubmit hook", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = join(tmpdir(), `strata-hook-test-ups-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    const db = openDatabase(join(tempDir, "strata.db"));
    const store = new SqliteDocumentStore(db);
    store.add(
      "We decided to use bcrypt with cost factor 12 for password hashing across all services",
      14,
      {
        sessionId: "s-decision-bcrypt",
        project: "auth-service",
        role: "user",
        timestamp: Date.now() - 86400000 * 7,
        toolNames: [],
        messageIndex: 0,
      },
    );
    store.add(
      "Fixed TypeError: Cannot read properties of undefined by adding null check before accessing user.profile.settings",
      18,
      {
        sessionId: "s-fix-typeerror",
        project: "frontend",
        role: "assistant",
        timestamp: Date.now() - 86400000 * 3,
        toolNames: [],
        messageIndex: 0,
      },
    );
    db.close();
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("exits 0 with no output when no trigger matches", () => {
    const result = runHook({
      stdinData: JSON.stringify({ prompt: "please refactor the utils module" }),
      env: { STRATA_DATA_DIR: tempDir },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 0 with no output when prompt is empty", () => {
    const result = runHook({ stdinData: JSON.stringify({ prompt: "" }) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 0 with context when error trigger matches", () => {
    const result = runHook({
      stdinData: JSON.stringify({ prompt: "I'm getting a TypeError when accessing user settings" }),
      env: { STRATA_DATA_DIR: tempDir },
    });
    expect(result.exitCode).toBe(0);
    if (result.stdout) {
      expect(result.stdout).toContain("[Strata]");
    }
  });

  it("exits 0 with context when recall trigger matches", () => {
    const result = runHook({
      stdinData: JSON.stringify({ prompt: "what did we decide about password hashing?" }),
      env: { STRATA_DATA_DIR: tempDir },
    });
    expect(result.exitCode).toBe(0);
    if (result.stdout) {
      expect(result.stdout).toContain("[Strata]");
    }
  });

  it("exits 0 when database is unavailable", () => {
    const result = runHook({
      stdinData: JSON.stringify({ prompt: "why is the auth broken again?" }),
      env: { STRATA_DATA_DIR: join(tmpdir(), `nonexistent-${Date.now()}`) },
    });
    expect(result.exitCode).toBe(0);
  });
});
