import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlayerRegistry } from "../../src/transports/player-registry.js";

let baseDir: string;
let registry: PlayerRegistry;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "strata-registry-test-"));
  registry = new PlayerRegistry(baseDir);
});

afterEach(() => {
  registry.close();
  rmSync(baseDir, { recursive: true, force: true });
});

describe("PlayerRegistry — provision", () => {
  it("generates a new player with pt_ prefixed token", async () => {
    const result = await registry.provision(null);
    expect(result.isNew).toBe(true);
    expect(result.playerToken).toMatch(/^pt_[0-9a-f]{32}$/);
    expect(result.playerId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("returns isNew:false on second provision with same externalId", async () => {
    const first = await registry.provision("steam:12345");
    const second = await registry.provision("steam:12345");
    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(second.playerId).toBe(first.playerId);
  });

  it("creates distinct players for different externalIds", async () => {
    const a = await registry.provision("steam:aaa");
    const b = await registry.provision("steam:bbb");
    expect(a.playerId).not.toBe(b.playerId);
    expect(a.playerToken).not.toBe(b.playerToken);
  });

  it("persists players.json to disk atomically", async () => {
    await registry.provision("steam:99999");
    const path = join(baseDir, "players.json");
    expect(existsSync(path)).toBe(true);
    const data = JSON.parse(readFileSync(path, "utf-8"));
    expect(data.version).toBe(1);
    expect(Object.keys(data.players).length).toBe(1);
    expect(data.externalIdIndex["steam:99999"]).toBeDefined();
  });

  it("never persists raw tokens — only sha256 hashes", async () => {
    const result = await registry.provision("steam:xyz");
    const data = JSON.parse(readFileSync(join(baseDir, "players.json"), "utf-8"));
    const entry = data.players[result.playerId];
    expect(entry.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(data)).not.toContain(result.playerToken);
  });
});

describe("PlayerRegistry — auth", () => {
  it("authenticates a valid raw token to its entry", async () => {
    const provisioned = await registry.provision("steam:auth");
    const entry = registry.auth(provisioned.playerToken);
    expect(entry).not.toBeNull();
    expect(entry!.playerId).toBe(provisioned.playerId);
  });

  it("returns null for an unknown token", () => {
    expect(registry.auth("pt_deadbeefdeadbeefdeadbeefdeadbeef")).toBeNull();
  });

  it("returns null for an empty token", () => {
    expect(registry.auth("")).toBeNull();
  });

  it("rejects a token whose expiresAt is in the past (Phase 2 hook)", async () => {
    const provisioned = await registry.provision("steam:expired");
    const entry = registry.get(provisioned.playerId);
    entry!.expiresAt = Date.now() - 1000;
    expect(registry.auth(provisioned.playerToken)).toBeNull();
  });
});

describe("PlayerRegistry — remove and get", () => {
  it("removes a player and invalidates its token", async () => {
    const provisioned = await registry.provision("steam:delete");
    expect(registry.remove(provisioned.playerId)).toBe(true);
    expect(registry.auth(provisioned.playerToken)).toBeNull();
    expect(registry.get(provisioned.playerId)).toBeNull();
  });

  it("returns false when removing an unknown playerId", () => {
    expect(registry.remove("nonexistent-uuid")).toBe(false);
  });
});

describe("PlayerRegistry — persistence across instances", () => {
  it("reloads players from disk on new instance", async () => {
    const result = await registry.provision("steam:reload");
    registry.close();

    const reloaded = new PlayerRegistry(baseDir);
    const entry = reloaded.auth(result.playerToken);
    expect(entry).not.toBeNull();
    expect(entry!.playerId).toBe(result.playerId);
    reloaded.close();
  });
});

describe("PlayerRegistry — concurrent provision", () => {
  it("serializes concurrent provisions on the same externalId", async () => {
    const [a, b, c] = await Promise.all([
      registry.provision("steam:concurrent"),
      registry.provision("steam:concurrent"),
      registry.provision("steam:concurrent"),
    ]);
    const newCount = [a, b, c].filter((r) => r.isNew).length;
    expect(newCount).toBe(1);
    expect(a.playerId).toBe(b.playerId);
    expect(b.playerId).toBe(c.playerId);
  });
});
