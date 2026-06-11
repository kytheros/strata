/**
 * SessionStop hook — summaries table write.
 *
 * The hook is the primary production writer of the summaries TABLE, and a
 * bare require("fs") in this ESM module made it a permanent silent no-op
 * (ReferenceError swallowed at the stdin read) — the founder corpus ended
 * up with 5 summaries for 698 sessions. These tests pin both the no-CJS
 * invariant and the end-to-end table write.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";

const projectRoot = join(import.meta.dirname, "../..").replace(/\\/g, "/");
const hookSource = join(projectRoot, "src/hooks/session-stop-hook.ts");

describe("SessionStop hook — ESM purity", () => {
  it("contains no bare require() calls (runs as pure ESM under node dist/)", () => {
    const source = readFileSync(hookSource, "utf-8");
    // createRequire is fine; bare require( is a ReferenceError in ESM.
    const bareRequires = source
      .split("\n")
      .filter((l) => /(?<!create)\brequire\s*\(/.test(l) && !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    expect(bareRequires).toEqual([]);
  });
});

describe("SessionStop hook — writes the summaries table", () => {
  let workDir: string;
  let dataDir: string;
  let fakeHome: string;
  let transcriptPath: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "strata-stop-hook-"));
    dataDir = join(workDir, "data");
    fakeHome = join(workDir, "home");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });

    // Minimal Claude Code transcript (>= 3 messages — the hook skips noise)
    const transcriptDir = join(workDir, "projects", "test-project");
    mkdirSync(transcriptDir, { recursive: true });
    transcriptPath = join(transcriptDir, "sess-hook-e2e.jsonl");
    const lines = [
      {
        type: "user",
        message: { role: "user", content: "Help me fix the SQLITE_BUSY errors in the worker" },
        timestamp: "2026-06-12T09:00:00Z",
        uuid: "u1",
        sessionId: "sess-hook-e2e",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Fixed: enabling WAL journal mode stops the SQLITE_BUSY contention." }],
        },
        timestamp: "2026-06-12T09:01:00Z",
        uuid: "a1",
        sessionId: "sess-hook-e2e",
      },
      {
        type: "user",
        message: { role: "user", content: "Great, that worked. We decided to use WAL mode everywhere now." },
        timestamp: "2026-06-12T09:02:00Z",
        uuid: "u2",
        sessionId: "sess-hook-e2e",
      },
    ].map((l) => JSON.stringify(l));
    writeFileSync(transcriptPath, lines.join("\n"));
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("persists a summaries row for the session", () => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      STRATA_DATA_DIR: dataDir,
      // Isolate home so incrementalUpdate() doesn't index this machine's
      // real sessions into the temp DB (and no real config.json leaks in).
      USERPROFILE: fakeHome,
      HOME: fakeHome,
    };
    delete env.GEMINI_API_KEY;

    const result = spawnSync("npx", ["tsx", hookSource.replace(/\\/g, "/")], {
      input: JSON.stringify({
        session_id: "sess-hook-e2e",
        transcript_path: transcriptPath,
      }),
      env,
      timeout: 60000,
      encoding: "utf-8",
      shell: true,
    });
    expect(result.status).toBe(0);

    const dbPath = join(dataDir, "strata.db");
    expect(existsSync(dbPath)).toBe(true);

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare("SELECT topic, message_count, data FROM summaries WHERE session_id = ?")
      .get("sess-hook-e2e") as { topic: string; message_count: number; data: string } | undefined;
    db.close();

    expect(row).toBeDefined();
    expect(row!.topic).toBeTruthy();
    expect(row!.message_count).toBe(3);
    // data must round-trip as a full SessionSummary (readers JSON.parse it)
    const parsed = JSON.parse(row!.data);
    expect(parsed.sessionId).toBe("sess-hook-e2e");
    expect(typeof parsed.hasCodeChanges).toBe("boolean");
  });
});
