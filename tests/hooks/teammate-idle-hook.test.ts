/**
 * Tests for TeammateIdle hook.
 *
 * Validates:
 * - Exit 0 and stores episodic memory on valid payload
 * - Exit 0 when payload is empty
 * - Exit 0 when database is unavailable
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { openDatabase } from "../../src/storage/database.js";

const projectRoot = join(import.meta.dirname, "../..").replace(/\\/g, "/");
const hookScript = join(projectRoot, "src/hooks/teammate-idle-hook.ts").replace(/\\/g, "/");

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

describe("TeammateIdle hook", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = join(tmpdir(), `strata-hook-test-idle-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const db = openDatabase(join(tempDir, "strata.db"));
    db.close();
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("exits 0 and stores episodic memory", () => {
    const result = runHook({
      stdinData: JSON.stringify({
        agent_name: "core-engine",
        session_id: "test-session-123",
        cwd: "/home/user/strata",
      }),
      env: { STRATA_DATA_DIR: tempDir },
    });
    expect(result.exitCode).toBe(0);

    // Verify the memory was stored
    const db = openDatabase(join(tempDir, "strata.db"));
    const row = db.prepare("SELECT * FROM knowledge WHERE type = 'episodic' AND summary LIKE '%core-engine%'").get() as any;
    db.close();
    expect(row).toBeDefined();
  });

  it("exits 0 when payload is empty", () => {
    const result = runHook({ stdinData: "{}" });
    expect(result.exitCode).toBe(0);
  });

  it("exits 0 when database is unavailable", () => {
    const result = runHook({
      stdinData: JSON.stringify({ agent_name: "test" }),
      env: { STRATA_DATA_DIR: join(tmpdir(), `nonexistent-${Date.now()}`) },
    });
    expect(result.exitCode).toBe(0);
  });
});
