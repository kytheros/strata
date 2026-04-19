/**
 * Unit tests for the legacy layout detection predicate.
 *
 * The guard in `strata serve --rest` must distinguish between:
 *   - Post-refactor no-auth data (players/.../strata.db) — should NOT block
 *   - Pre-refactor JSON-tree data (agents/.../profile.json etc.) — SHOULD block
 *
 * Regression: the original guard fired on any `players/` or `agents/` directory,
 * which broke `strata serve --rest` against valid post-refactor data dirs that
 * legitimately contain `players/default/agents/{npcId}/strata.db`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasLegacyLayout } from "../../src/storage/legacy-layout.js";

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "strata-legacy-layout-test-"));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("hasLegacyLayout", () => {
  it("returns false for a completely empty data dir", () => {
    expect(hasLegacyLayout(baseDir)).toBe(false);
  });

  it("returns false when only worlds/ exists (already migrated)", () => {
    mkdirSync(join(baseDir, "worlds", "default"), { recursive: true });
    expect(hasLegacyLayout(baseDir)).toBe(false);
  });

  it("returns false for post-refactor no-auth layout: players/default/agents/npc/strata.db", () => {
    // This is the layout created by the current no-auth code path.
    // It must NOT trip the guard.
    const npcDir = join(baseDir, "players", "default", "agents", "goran-blacksmith");
    mkdirSync(npcDir, { recursive: true });
    writeFileSync(join(npcDir, "strata.db"), "");
    expect(hasLegacyLayout(baseDir)).toBe(false);
  });

  it("returns false when players/ exists but has no JSON markers", () => {
    // players/ directory with only sqlite databases — post-refactor layout
    mkdirSync(join(baseDir, "players", "default"), { recursive: true });
    expect(hasLegacyLayout(baseDir)).toBe(false);
  });

  it("returns true when agents/{npcId}/profile.json exists (pre-refactor NPC profiles)", () => {
    const npcDir = join(baseDir, "agents", "goran");
    mkdirSync(npcDir, { recursive: true });
    writeFileSync(join(npcDir, "profile.json"), JSON.stringify({
      name: "Goran", alignment: { ethical: "lawful", moral: "good" },
      defaultTrust: 0, factionBias: {}, gossipTrait: "normal", traits: [], backstory: "",
    }));
    expect(hasLegacyLayout(baseDir)).toBe(true);
  });

  it("returns true when players/{playerId}/character.json exists (pre-refactor player characters)", () => {
    const playerDir = join(baseDir, "players", "player-1");
    mkdirSync(playerDir, { recursive: true });
    writeFileSync(join(playerDir, "character.json"), JSON.stringify({
      name: "Aethelred", class: "warrior",
    }));
    expect(hasLegacyLayout(baseDir)).toBe(true);
  });

  it("returns true when players/{playerId}/agents/{npcId}/relationship.json exists (pre-refactor relationships)", () => {
    const relDir = join(baseDir, "players", "player-1", "agents", "goran");
    mkdirSync(relDir, { recursive: true });
    writeFileSync(join(relDir, "relationship.json"), JSON.stringify({
      trust: 50, disposition: "friendly",
    }));
    expect(hasLegacyLayout(baseDir)).toBe(true);
  });

  it("returns true when agents/ dir exists with a profile.json even if players/ also has strata.db files", () => {
    // Mixed state — legacy agents + current players
    const npcDir = join(baseDir, "agents", "goran");
    mkdirSync(npcDir, { recursive: true });
    writeFileSync(join(npcDir, "profile.json"), "{}");
    const dbDir = join(baseDir, "players", "default", "agents", "goran");
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(join(dbDir, "strata.db"), "");
    expect(hasLegacyLayout(baseDir)).toBe(true);
  });

  it("returns false when agents/ dir exists but contains no profile.json files", () => {
    // agents/ directory without any profile.json — not a legacy marker
    mkdirSync(join(baseDir, "agents", "goran"), { recursive: true });
    // Only a strata.db, no profile.json
    writeFileSync(join(baseDir, "agents", "goran", "strata.db"), "");
    expect(hasLegacyLayout(baseDir)).toBe(false);
  });
});
