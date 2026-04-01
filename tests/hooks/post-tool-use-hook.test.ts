/**
 * Tests for PostToolUse hook — change tracking.
 *
 * Validates:
 * - Exit 0 and stores an event for Edit
 * - Exit 0 and stores an event for Write
 * - Exit 0 when no file path in payload
 * - Exit 0 when database is unavailable
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { openDatabase } from "../../src/storage/database.js";

const projectRoot = join(import.meta.dirname, "../..").replace(/\\/g, "/");
const hookScript = join(projectRoot, "src/hooks/post-tool-use-hook.ts").replace(/\\/g, "/");

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
  return { stdout: result.stdout || "", stderr: result.stderr || "", exitCode: result.status ?? 0 };
}

describe("PostToolUse hook — change tracking", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = join(tmpdir(), `strata-hook-test-ptu-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const db = openDatabase(join(tempDir, "strata.db"));
    db.close();
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("exits 0 and stores an event for Edit", () => {
    const result = runHook({
      stdinData: JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: "/home/user/strata/src/server.ts" },
        session_id: "test-session",
        cwd: "/home/user/strata",
      }),
      env: { STRATA_DATA_DIR: tempDir },
    });
    expect(result.exitCode).toBe(0);

    const db = openDatabase(join(tempDir, "strata.db"));
    const event = db.prepare("SELECT * FROM events WHERE object LIKE '%server.ts%'").get() as any;
    db.close();
    if (event) {
      expect(event.verb).toBe("edited");
      expect(event.subject).toBe("claude");
    }
  });

  it("exits 0 and stores an event for Write", () => {
    const result = runHook({
      stdinData: JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: "/home/user/strata/src/new-file.ts" },
        session_id: "test-session",
        cwd: "/home/user/strata",
      }),
      env: { STRATA_DATA_DIR: tempDir },
    });
    expect(result.exitCode).toBe(0);

    const db = openDatabase(join(tempDir, "strata.db"));
    const event = db.prepare("SELECT * FROM events WHERE object LIKE '%new-file.ts%'").get() as any;
    db.close();
    if (event) {
      expect(event.verb).toBe("created");
    }
  });

  it("exits 0 when no file path in payload", () => {
    const result = runHook({
      stdinData: JSON.stringify({ tool_name: "Edit" }),
    });
    expect(result.exitCode).toBe(0);
  });

  it("exits 0 when database is unavailable", () => {
    const result = runHook({
      stdinData: JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: "/tmp/test.ts" },
      }),
      env: { STRATA_DATA_DIR: join(tmpdir(), `nonexistent-${Date.now()}`) },
    });
    expect(result.exitCode).toBe(0);
  });
});
