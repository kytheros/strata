import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NpcProfileStore } from "../../src/transports/npc-profile-store.js";

let baseDir: string;
let store: NpcProfileStore;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "strata-profile-test-"));
  store = new NpcProfileStore(baseDir);
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

const validProfile = {
  name: "Goran",
  title: "Blacksmith",
  alignment: { ethical: "lawful", moral: "good" },
  faction: "millhaven-merchants",
  traits: ["honest"],
  backstory: "Runs the forge.",
  defaultTrust: -0.1,
  factionBias: { "millhaven-merchants": 0.3, "thieves-guild": -0.4 },
};

describe("NpcProfileStore", () => {
  it("write + read round-trips a profile", () => {
    store.write("goran", validProfile);
    const profile = store.read("goran");
    expect(profile).not.toBeNull();
    expect(profile!.name).toBe("Goran");
    expect(profile!.alignment.ethical).toBe("lawful");
    expect(profile!.defaultTrust).toBe(-0.1);
    expect(profile!.factionBias["thieves-guild"]).toBe(-0.4);
  });

  it("read returns null for unknown NPC", () => {
    expect(store.read("unknown")).toBeNull();
  });

  it("rejects missing name", () => {
    expect(() => store.write("bad", { alignment: { ethical: "lawful", moral: "good" } }))
      .toThrow(/Missing required field: name/);
  });

  it("rejects invalid alignment values", () => {
    expect(() => store.write("bad", { name: "X", alignment: { ethical: "chaotic-good", moral: "good" } }))
      .toThrow(/Invalid alignment/);
  });

  it("rejects defaultTrust out of range", () => {
    expect(() => store.write("bad", { ...validProfile, defaultTrust: 2.0 }))
      .toThrow(/defaultTrust must be between/);
  });

  it("applies defaults for missing optional fields", () => {
    store.write("minimal", { name: "Test", alignment: { ethical: "neutral", moral: "neutral" } });
    const p = store.read("minimal")!;
    expect(p.traits).toEqual([]);
    expect(p.backstory).toBe("");
    expect(p.defaultTrust).toBe(0);
    expect(p.factionBias).toEqual({});
    expect(p.tagRules).toBeNull();
  });

  it("stores and reads tagRules overrides", () => {
    store.write("corrupt", {
      ...validProfile,
      tagRules: { bribery: { trust: 0.2 }, theft: { trust: -0.05 } },
    });
    const p = store.read("corrupt")!;
    expect(p.tagRules!.bribery.trust).toBe(0.2);
    expect(p.tagRules!.theft.trust).toBe(-0.05);
  });

  it("creates the agents/{npcId}/ directory structure", () => {
    store.write("goran", validProfile);
    expect(existsSync(join(baseDir, "agents", "goran", "profile.json"))).toBe(true);
  });
});
