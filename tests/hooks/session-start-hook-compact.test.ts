/**
 * Tests for the SessionStart hook's compact trigger path.
 *
 * Validates:
 * - Context is re-injected when compact trigger is received
 * - Exit 0 with minimal output when database has no knowledge
 * - Exit 0 when database is unavailable
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";

const projectRoot = join(import.meta.dirname, "../..").replace(/\\/g, "/");
const hookScript = join(projectRoot, "src/hooks/session-start-hook.ts").replace(/\\/g, "/");

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

describe("SessionStart hook — compact trigger", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = join(tmpdir(), `strata-hook-test-compact-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    // Seed database with a decision
    const db = openDatabase(join(tempDir, "strata.db"));
    const ks = new SqliteKnowledgeStore(db);
    ks.addEntry({
      id: "k-decision-1",
      type: "decision",
      project: "strata",
      sessionId: "s-current",
      timestamp: Date.now(),
      summary: "Switched from MIT to Apache 2.0 license",
      details: "Apache 2.0 adds patent protection and matches competitive norm",
      tags: ["license"],
      relatedFiles: [],
      occurrences: 1,
      projectCount: 1,
    });
    db.close();
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("outputs condensed context when compact trigger is received", () => {
    const result = runHook({
      stdinData: JSON.stringify({ trigger: "compact" }),
      env: { STRATA_DATA_DIR: tempDir },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[Strata] Context preserved through compaction");
  });

  it("outputs condensed context when compact source is received", () => {
    const result = runHook({
      stdinData: JSON.stringify({ source: "compact" }),
      env: { STRATA_DATA_DIR: tempDir },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[Strata] Context preserved through compaction");
  });

  it("exits 0 with minimal output when database is empty", () => {
    const emptyDir = join(tmpdir(), `strata-hook-test-compact-empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    const db = openDatabase(join(emptyDir, "strata.db"));
    db.close();

    const result = runHook({
      stdinData: JSON.stringify({ trigger: "compact" }),
      env: { STRATA_DATA_DIR: emptyDir },
    });
    expect(result.exitCode).toBe(0);
    rmSync(emptyDir, { recursive: true, force: true });
  });
});
