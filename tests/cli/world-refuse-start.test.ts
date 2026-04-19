/**
 * Task 13: Server refuses to start when legacy layout is detected.
 *
 * The guard now uses JSON-marker heuristics (profile.json, character.json,
 * relationship.json) rather than bare directory existence, so post-refactor
 * no-auth layouts with a `players/` directory are no longer blocked.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "../..");
const cliPath = join(projectRoot, "src/cli.ts");

/** Spawn the CLI with a given STRATA_DATA_DIR and capture output synchronously. */
function spawnCli(
  args: string[],
  dataDir: string,
  timeoutMs = 8_000
): { exitCode: number; stderr: string; stdout: string } {
  const result = spawnSync(
    "npx",
    ["tsx", cliPath, ...args],
    {
      cwd: projectRoot,
      timeout: timeoutMs,
      encoding: "utf-8",
      // shell:true is required on Windows so that `npx` resolves from PATH
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        STRATA_DATA_DIR: dataDir,
        // Suppress verbose Strata memory warnings in test output
        NO_COLOR: "1",
      },
    }
  );
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "strata-refuse-start-"));
});

afterEach(() => {
  // maxRetries handles EBUSY on Windows when a spawned server still holds SQLite file handles
  rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("serve --rest: refuse-to-start on legacy layout", () => {
  it("exits non-zero when agents/{npcId}/profile.json exists (pre-refactor marker)", () => {
    mkdirSync(join(baseDir, "agents", "goran"), { recursive: true });
    writeFileSync(join(baseDir, "agents", "goran", "profile.json"), JSON.stringify({
      name: "Goran", alignment: { ethical: "lawful", moral: "good" },
      defaultTrust: 0, factionBias: {}, gossipTrait: "normal", traits: [], backstory: "",
    }));
    const result = spawnCli(["serve", "--rest", "--rest-port", "0"], baseDir);
    expect(result.exitCode).not.toBe(0);
    const combined = result.stderr + result.stdout;
    expect(combined).toMatch(/world-migrate/i);
  });

  it("exits non-zero when players/{playerId}/character.json exists (pre-refactor marker)", () => {
    mkdirSync(join(baseDir, "players", "player-1"), { recursive: true });
    writeFileSync(join(baseDir, "players", "player-1", "character.json"), JSON.stringify({
      name: "Aethelred", class: "warrior",
    }));
    const result = spawnCli(["serve", "--rest", "--rest-port", "0"], baseDir);
    expect(result.exitCode).not.toBe(0);
    const combined = result.stderr + result.stdout;
    expect(combined).toMatch(/world-migrate/i);
  });

  it("exits non-zero when players/{playerId}/agents/{npcId}/relationship.json exists (pre-refactor marker)", () => {
    const relDir = join(baseDir, "players", "player-1", "agents", "goran");
    mkdirSync(relDir, { recursive: true });
    writeFileSync(join(relDir, "relationship.json"), JSON.stringify({ trust: 50 }));
    const result = spawnCli(["serve", "--rest", "--rest-port", "0"], baseDir);
    expect(result.exitCode).not.toBe(0);
    const combined = result.stderr + result.stdout;
    expect(combined).toMatch(/world-migrate/i);
  });

  it("starts normally when players/ exists but contains only post-refactor strata.db files", () => {
    // This is the scenario that was wrongly blocked before the fix.
    // players/default/agents/goran-blacksmith/strata.db is the current no-auth layout.
    const npcDir = join(baseDir, "players", "default", "agents", "goran-blacksmith");
    mkdirSync(npcDir, { recursive: true });
    writeFileSync(join(npcDir, "strata.db"), "");
    const result = spawnCli(["serve", "--rest", "--rest-port", "0"], baseDir, 4_000);
    const combined = result.stderr + result.stdout;
    expect(combined).not.toMatch(/world-migrate/i);
  });

  it("starts normally when agents/ exists but contains no profile.json files", () => {
    // Bare agents/ dir without JSON markers must not block
    mkdirSync(join(baseDir, "agents", "goran"), { recursive: true });
    writeFileSync(join(baseDir, "agents", "goran", "strata.db"), "");
    const result = spawnCli(["serve", "--rest", "--rest-port", "0"], baseDir, 4_000);
    const combined = result.stderr + result.stdout;
    expect(combined).not.toMatch(/world-migrate/i);
  });

  it("starts normally (does not exit immediately) when only worlds/ exists", () => {
    mkdirSync(join(baseDir, "worlds"), { recursive: true });
    // Spawn with a very short timeout — if the process exits immediately it
    // means the guard fired; if it times out (ETIMEDOUT / status null) the
    // server started as expected.
    const result = spawnCli(["serve", "--rest", "--rest-port", "0"], baseDir, 4_000);
    // Either timed out (null = success from our POV) or 0 (clean start+stop)
    // It must NOT have exited with the legacy-guard error code 1
    const combined = result.stderr + result.stdout;
    expect(combined).not.toMatch(/world-migrate/i);
  });

  it("starts normally when data dir is empty", () => {
    const result = spawnCli(["serve", "--rest", "--rest-port", "0"], baseDir, 4_000);
    const combined = result.stderr + result.stdout;
    expect(combined).not.toMatch(/world-migrate/i);
  });
});

describe("world-migrate CLI command", () => {
  it("reports success after migrating a legacy tree", () => {
    // Seed a minimal legacy layout — just needs the directory to be present
    mkdirSync(join(baseDir, "agents", "goran"), { recursive: true });
    writeFileSync(join(baseDir, "agents", "goran", "profile.json"), JSON.stringify({
      name: "Goran", alignment: { ethical: "lawful", moral: "good" },
      defaultTrust: 0, factionBias: {}, gossipTrait: "normal", traits: [], backstory: "",
    }));
    const result = spawnCli(["world-migrate", "--data-dir", baseDir], baseDir);
    // migrated=true → exits 0
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Migration complete/i);
  });

  it("exits 1 when no legacy layout found", () => {
    const result = spawnCli(["world-migrate", "--data-dir", baseDir], baseDir);
    // migrated=false → exits 1
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/No legacy layout/i);
  });
});
