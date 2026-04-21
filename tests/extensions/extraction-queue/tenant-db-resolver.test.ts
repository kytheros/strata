import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import {
  CompositeTenantResolver,
  TenantWriteTarget,
} from "../../../src/extensions/extraction-queue/tenant-db-resolver.js";

describe("CompositeTenantResolver", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "strata-resolver-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("v2 tenantId dispatches to v2 handler with matching worldId", async () => {
    const worldDb = new Database(join(dir, "world.db"));
    let called: { worldId?: string; agentId?: string } = {};
    const resolver = new CompositeTenantResolver({
      v2: async (worldId, agentId, fn) => {
        called = { worldId, agentId };
        const target: TenantWriteTarget = { kind: "v2", worldDb, agentId };
        return fn(target);
      },
      legacy: async () => {
        throw new Error("should not be called");
      },
    });
    const result = await resolver.withTenantDb(
      "v2:world-abc",
      "goran",
      async (t) => (t.kind === "v2" ? t.agentId : "wrong"),
    );
    expect(result).toBe("goran");
    expect(called).toEqual({ worldId: "world-abc", agentId: "goran" });
    worldDb.close();
  });

  test("legacy tenantId dispatches to legacy handler with matching playerId", async () => {
    let called: { playerId?: string; agentId?: string } = {};
    const resolver = new CompositeTenantResolver({
      v2: async () => {
        throw new Error("should not be called");
      },
      legacy: async (playerId, agentId, fn) => {
        called = { playerId, agentId };
        const target: TenantWriteTarget = {
          kind: "legacy",
          addEntry: async () => "legacy-id",
          agentId,
        };
        return fn(target);
      },
    });
    const result = await resolver.withTenantDb(
      "legacy:player-xyz",
      "goran",
      async (t) => (t.kind === "legacy" ? t.agentId : "wrong"),
    );
    expect(result).toBe("goran");
    expect(called).toEqual({ playerId: "player-xyz", agentId: "goran" });
  });

  test("unknown tenantId prefix throws", async () => {
    const resolver = new CompositeTenantResolver({
      v2: async () => {
        throw new Error("no");
      },
      legacy: async () => {
        throw new Error("no");
      },
    });
    await expect(
      resolver.withTenantDb("bogus:xxx", "a", async () => null),
    ).rejects.toThrow(/unknown tenant/i);
  });
});
