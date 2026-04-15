import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../src/transports/world-schema.js";
import { NpcProfileStore } from "../../src/transports/npc-profile-store.js";
import type { NpcProfile } from "../../src/transports/npc-profile-store.js";

let db: Database.Database;
let store: NpcProfileStore;

beforeEach(() => {
  db = new Database(":memory:");
  applySchema(db);
  store = new NpcProfileStore(db);
});

afterEach(() => {
  db.close();
});

const validProfileInput: Record<string, unknown> = {
  name: "Goran",
  title: "Blacksmith",
  alignment: { ethical: "lawful", moral: "good" },
  faction: "millhaven-merchants",
  traits: ["honest"],
  backstory: "Runs the forge.",
  defaultTrust: -0.1,
  factionBias: { "millhaven-merchants": 0.3, "thieves-guild": -0.4 },
  gossipTrait: "normal",
};

describe("NpcProfileStore (SQL)", () => {
  it("put + get round-trips a profile", () => {
    const profile = store.put("goran", validProfileInput);
    const fetched = store.get("goran");
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe("Goran");
    expect(fetched!.alignment.ethical).toBe("lawful");
    expect(fetched!.defaultTrust).toBeCloseTo(-0.1);
    expect(fetched!.factionBias["thieves-guild"]).toBeCloseTo(-0.4);
    expect(fetched!.gossipTrait).toBe("normal");
  });

  it("get returns null for unknown NPC", () => {
    expect(store.get("unknown")).toBeNull();
  });

  it("put on existing npcId updates the record", () => {
    store.put("goran", validProfileInput);
    store.put("goran", { ...validProfileInput, name: "Goran Updated" });
    const fetched = store.get("goran");
    expect(fetched!.name).toBe("Goran Updated");
  });

  it("list returns all stored profiles", () => {
    store.put("goran", validProfileInput);
    store.put("brynn", { ...validProfileInput, name: "Brynn" });
    const profiles = store.list();
    expect(profiles.length).toBe(2);
    const names = profiles.map(p => p.name).sort();
    expect(names).toEqual(["Brynn", "Goran"]);
  });

  it("list returns empty array when no profiles", () => {
    expect(store.list()).toEqual([]);
  });

  it("stores and reads tagRules overrides", () => {
    store.put("corrupt", {
      ...validProfileInput,
      tagRules: { bribery: { trust: 0.2 }, theft: { trust: -0.05 } },
    });
    const p = store.get("corrupt")!;
    expect(p.tagRules!.bribery.trust).toBe(0.2);
    expect(p.tagRules!.theft.trust).toBe(-0.05);
  });

  it("stores extended tagRules with anchor fields", () => {
    store.put("anchor-tags-npc", {
      ...validProfileInput,
      tagRules: {
        "saved-my-life": { trust: 0.4, promoteAnchor: true, minAnchorDepth: 0.6 },
        "betrayal": { trust: -0.5, breakAnchor: true },
      },
    });
    const p = store.get("anchor-tags-npc")!;
    expect(p.tagRules!["saved-my-life"].trust).toBe(0.4);
    expect(p.tagRules!["saved-my-life"].promoteAnchor).toBe(true);
    expect(p.tagRules!["saved-my-life"].minAnchorDepth).toBe(0.6);
    expect(p.tagRules!["betrayal"].breakAnchor).toBe(true);
  });

  it("stores and reads decayProfile and decayConfig", () => {
    store.put("custom-npc", {
      ...validProfileInput,
      decayProfile: "custom",
      decayConfig: { lambdaBase: 0.05, lambdaTrust: 0.03, blendAlpha: 0.6, dayEquivalent: 1.5 },
    });
    const p = store.get("custom-npc")!;
    expect(p.decayProfile).toBe("custom");
    expect(p.decayConfig!.lambdaBase).toBe(0.05);
    expect(p.decayConfig!.blendAlpha).toBe(0.6);
  });

  it("stores and reads anchorConfig", () => {
    store.put("anchor-npc", {
      ...validProfileInput,
      anchorConfig: {
        familiarityThreshold: 30,
        rivalThreshold: 0.4,
        depthIncrement: 0.2,
        passiveDepthCeiling: 0.4,
        passiveDepthRate: 0.02,
      },
    });
    const p = store.get("anchor-npc")!;
    expect(p.anchorConfig!.familiarityThreshold).toBe(30);
    expect(p.anchorConfig!.rivalThreshold).toBe(0.4);
  });

  it("stores and reads propagateTags and gossipTrait", () => {
    store.put("goran", {
      ...validProfileInput,
      propagateTags: ["rumor", "confession"],
      gossipTrait: "gossipy",
    });
    const p = store.get("goran")!;
    expect(p.propagateTags).toEqual(["rumor", "confession"]);
    expect(p.gossipTrait).toBe("gossipy");
  });

  it("defaults gossipTrait to 'normal' when absent", () => {
    store.put("minimal", { name: "Test", alignment: { ethical: "neutral", moral: "neutral" } });
    const p = store.get("minimal")!;
    expect(p.gossipTrait).toBe("normal");
  });

  it("applies defaults for missing optional fields", () => {
    store.put("minimal", { name: "Test", alignment: { ethical: "neutral", moral: "neutral" } });
    const p = store.get("minimal")!;
    expect(p.traits).toEqual([]);
    expect(p.backstory).toBe("");
    expect(p.defaultTrust).toBe(0);
    expect(p.factionBias).toEqual({});
    expect(p.tagRules).toBeNull();
  });

  it("rejects missing name", () => {
    expect(() => store.put("bad", { alignment: { ethical: "lawful", moral: "good" } }))
      .toThrow(/Missing required field: name/);
  });

  it("rejects invalid alignment values", () => {
    expect(() => store.put("bad", { name: "X", alignment: { ethical: "chaotic-good", moral: "good" } }))
      .toThrow(/Invalid alignment/);
  });

  it("rejects defaultTrust out of range", () => {
    expect(() => store.put("bad", { ...validProfileInput, defaultTrust: 2.0 }))
      .toThrow(/defaultTrust must be between/);
  });

  it("rejects invalid gossipTrait", () => {
    expect(() =>
      store.put("bad", { ...validProfileInput, gossipTrait: "bogus" })
    ).toThrow(/gossipTrait/);
  });

  it("rejects invalid decayProfile value", () => {
    expect(() =>
      store.put("bad", { ...validProfileInput, decayProfile: "invalid-name" })
    ).toThrow(/decayProfile must be/);
  });

  it("defaults decayProfile to undefined when not provided", () => {
    store.put("minimal2", { name: "Test", alignment: { ethical: "neutral", moral: "neutral" } });
    const p = store.get("minimal2")!;
    expect(p.decayProfile).toBeUndefined();
    expect(p.decayConfig).toBeUndefined();
    expect(p.anchorConfig).toBeUndefined();
  });
});
