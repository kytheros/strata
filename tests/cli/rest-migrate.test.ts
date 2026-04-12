import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRestMigrate } from "../../src/cli/rest-migrate.js";

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "strata-rest-migrate-"));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

function makeAgentDir(name: string): void {
  const dir = join(baseDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "strata.db"), "fake sqlite");
}

describe("rest-migrate", () => {
  it("moves flat agent dirs under players/<id>/agents/", () => {
    makeAgentDir("goran-blacksmith");
    makeAgentDir("brynn-innkeeper");
    makeAgentDir("mira-herbalist");

    const result = runRestMigrate({
      baseDir,
      playerId: "default",
      dryRun: false,
    });

    expect(result.moved.sort()).toEqual([
      "brynn-innkeeper",
      "goran-blacksmith",
      "mira-herbalist",
    ]);
    expect(existsSync(join(baseDir, "players", "default", "agents", "goran-blacksmith", "strata.db"))).toBe(true);
    expect(existsSync(join(baseDir, "goran-blacksmith"))).toBe(false);
  });

  it("--dry-run reports what would move without touching disk", () => {
    makeAgentDir("goran-blacksmith");
    const result = runRestMigrate({
      baseDir,
      playerId: "default",
      dryRun: true,
    });
    expect(result.moved).toEqual(["goran-blacksmith"]);
    expect(existsSync(join(baseDir, "goran-blacksmith"))).toBe(true);
    expect(existsSync(join(baseDir, "players", "default"))).toBe(false);
  });

  it("skips directories without a strata.db inside", () => {
    mkdirSync(join(baseDir, "empty-dir"), { recursive: true });
    makeAgentDir("goran");
    const result = runRestMigrate({
      baseDir,
      playerId: "default",
      dryRun: false,
    });
    expect(result.moved).toEqual(["goran"]);
    expect(result.skipped).toContain("empty-dir");
  });

  it("skips reserved top-level names (players, sessions, players.json)", () => {
    mkdirSync(join(baseDir, "players"), { recursive: true });
    mkdirSync(join(baseDir, "sessions"), { recursive: true });
    writeFileSync(join(baseDir, "players.json"), "{}");
    makeAgentDir("goran");
    const result = runRestMigrate({
      baseDir,
      playerId: "fresh",
      dryRun: false,
    });
    expect(result.moved).toEqual(["goran"]);
  });

  it("refuses to run when the target player already exists", () => {
    mkdirSync(join(baseDir, "players", "default"), { recursive: true });
    makeAgentDir("goran");
    expect(() =>
      runRestMigrate({ baseDir, playerId: "default", dryRun: false })
    ).toThrow(/already exists/);
  });
});
