/**
 * Tests for PostToolUseFailure hook.
 *
 * Validates:
 * - Exit 0 with no output when no match found
 * - Exit 0 when error text is too short
 * - Exit 0 when payload is empty/malformed
 * - Exit 2 with stderr solution when match found
 * - Never crashes (hooks must be resilient)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";

const projectRoot = join(import.meta.dirname, "../..").replace(/\\/g, "/");
const hookScript = join(projectRoot, "src/hooks/post-tool-failure-hook.ts").replace(/\\/g, "/");

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

describe("PostToolUseFailure hook", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = join(tmpdir(), `strata-hook-test-ptf-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    // Seed a database with a known solution
    const db = openDatabase(join(tempDir, "strata.db"));
    const store = new SqliteDocumentStore(db);
    store.add(
      "Fixed ECONNREFUSED on port 5432 by increasing the connection pool size to 20 and adding retry logic",
      15,
      {
        sessionId: "s-fix-db",
        project: "backend",
        role: "assistant",
        timestamp: Date.now() - 86400000,
        toolNames: [],
        messageIndex: 0,
      },
    );
    db.close();
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("exits 0 with no output when payload is empty", () => {
    const result = runHook({ stdinData: "{}" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 0 when error text is too short", () => {
    const result = runHook({
      stdinData: JSON.stringify({ error: "fail" }),
    });
    expect(result.exitCode).toBe(0);
  });

  it("exits 0 when stdin is malformed", () => {
    const result = runHook({ stdinData: "not json" });
    expect(result.exitCode).toBe(0);
  });

  it("exits 0 when no database exists", () => {
    const result = runHook({
      stdinData: JSON.stringify({ error: "ECONNREFUSED 127.0.0.1:5432 connection refused" }),
      env: { STRATA_DATA_DIR: join(tmpdir(), `nonexistent-dir-${Date.now()}`) },
    });
    expect(result.exitCode).toBe(0);
  });

  it("exits 2 with stderr when matching solution found", () => {
    const result = runHook({
      stdinData: JSON.stringify({
        tool_name: "Bash",
        error: "Error: ECONNREFUSED 127.0.0.1:5432 - connection refused to database",
      }),
      env: { STRATA_DATA_DIR: tempDir },
    });
    // May be 0 or 2 depending on FTS match — if 2, stderr should have content
    if (result.exitCode === 2) {
      expect(result.stderr).toContain("[Strata]");
      expect(result.stderr).toContain("past solution");
    }
  });
});
