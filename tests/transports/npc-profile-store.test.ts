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

  it("stores and reads decayProfile field", () => {
    store.write("fading-npc", {
      ...validProfile,
      decayProfile: "fading",
    });
    const p = store.read("fading-npc")!;
    expect(p.decayProfile).toBe("fading");
  });

  it("stores and reads custom decayConfig", () => {
    store.write("custom-npc", {
      ...validProfile,
      decayProfile: "custom",
      decayConfig: {
        lambdaBase: 0.05,
        lambdaTrust: 0.03,
        blendAlpha: 0.6,
        dayEquivalent: 1.5,
      },
    });
    const p = store.read("custom-npc")!;
    expect(p.decayProfile).toBe("custom");
    expect(p.decayConfig!.lambdaBase).toBe(0.05);
    expect(p.decayConfig!.blendAlpha).toBe(0.6);
  });

  it("stores and reads anchorConfig", () => {
    store.write("anchor-npc", {
      ...validProfile,
      anchorConfig: {
        familiarityThreshold: 30,
        rivalThreshold: 0.4,
        depthIncrement: 0.2,
        passiveDepthCeiling: 0.4,
        passiveDepthRate: 0.02,
      },
    });
    const p = store.read("anchor-npc")!;
    expect(p.anchorConfig!.familiarityThreshold).toBe(30);
    expect(p.anchorConfig!.rivalThreshold).toBe(0.4);
  });

  it("defaults decayProfile to undefined when not provided", () => {
    store.write("minimal2", { name: "Test", alignment: { ethical: "neutral", moral: "neutral" } });
    const p = store.read("minimal2")!;
    expect(p.decayProfile).toBeUndefined();
    expect(p.decayConfig).toBeUndefined();
    expect(p.anchorConfig).toBeUndefined();
  });

  it("rejects invalid decayProfile value", () => {
    expect(() =>
      store.write("bad", { ...validProfile, decayProfile: "invalid-name" })
    ).toThrow(/decayProfile must be/);
  });

  it("stores extended tagRules with anchor fields", () => {
    store.write("anchor-tags-npc", {
      ...validProfile,
      tagRules: {
        "saved-my-life": { trust: 0.4, promoteAnchor: true, minAnchorDepth: 0.6 },
        "betrayal": { trust: -0.5, breakAnchor: true },
      },
    });
    const p = store.read("anchor-tags-npc")!;
    expect(p.tagRules!["saved-my-life"].trust).toBe(0.4);
    expect(p.tagRules!["saved-my-life"].promoteAnchor).toBe(true);
    expect(p.tagRules!["saved-my-life"].minAnchorDepth).toBe(0.6);
    expect(p.tagRules!["betrayal"].breakAnchor).toBe(true);
  });

  it("persists propagateTags and gossipTrait", () => {
    store.write("goran", {
      name: "Goran",
      alignment: { ethical: "lawful", moral: "good" },
      propagateTags: ["rumor", "confession"],
      gossipTrait: "gossipy",
    });
    const profile = store.read("goran");
    expect(profile?.propagateTags).toEqual(["rumor", "confession"]);
    expect(profile?.gossipTrait).toBe("gossipy");
  });

  it("defaults gossipTrait to 'normal' when absent", () => {
    store.write("goran", {
      name: "Goran",
      alignment: { ethical: "neutral", moral: "neutral" },
    });
    const profile = store.read("goran");
    expect(profile?.gossipTrait).toBe("normal");
  });

  it("rejects invalid gossipTrait", () => {
    expect(() =>
      store.write("goran", {
        name: "Goran",
        alignment: { ethical: "neutral", moral: "neutral" },
        gossipTrait: "bogus",
      })
    ).toThrow(/gossipTrait/);
  });
});
