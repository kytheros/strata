import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../src/transports/world-schema.js";
import { RelationshipStore } from "../../src/transports/relationship-store.js";
import type { NpcProfile } from "../../src/transports/npc-profile-store.js";
import type { CharacterCard } from "../../src/transports/character-store.js";
import type { AnchorOutcome } from "../../src/transports/tag-rule-engine.js";

let db: Database.Database;
let store: RelationshipStore;

const goranProfile: NpcProfile = {
  name: "Goran",
  alignment: { ethical: "lawful", moral: "good" },
  faction: "millhaven-merchants",
  traits: ["honest"],
  backstory: "Runs the forge.",
  defaultTrust: -0.1,
  factionBias: { "millhaven-merchants": 0.3, "thieves-guild": -0.4 },
  gossipTrait: "normal",
};

const merchantPlayer: CharacterCard = {
  displayName: "Mike",
  factions: ["millhaven-merchants"],
  tags: ["human"],
};

const unknownPlayer: CharacterCard = {
  displayName: "Stranger",
  factions: [],
  tags: [],
};

const thiefPlayer: CharacterCard = {
  displayName: "Shadow",
  factions: ["thieves-guild"],
  tags: ["elf"],
};

beforeEach(() => {
  db = new Database(":memory:");
  applySchema(db);
  store = new RelationshipStore(db);
});

afterEach(() => {
  db.close();
});

describe("RelationshipStore (SQL) — first-contact computation", () => {
  it("merchant player gets positive bias from Goran", () => {
    const result = store.get("player1", "goran", goranProfile, merchantPlayer);
    expect(result.trust).toBeCloseTo(0.2); // -0.1 + 0.3
    expect(result.familiarity).toBe(0);
    expect(result.disposition).toBe("wary");
    expect(result.observations).toEqual([]);
  });

  it("unknown player gets defaultTrust only", () => {
    const result = store.get("player1", "goran", goranProfile, unknownPlayer);
    expect(result.trust).toBeCloseTo(-0.1);
    expect(result.disposition).toBe("suspicious");
  });

  it("thief player gets negative bias from Goran", () => {
    const result = store.get("player1", "goran", goranProfile, thiefPlayer);
    expect(result.trust).toBeCloseTo(-0.5);
    expect(result.disposition).toBe("suspicious");
  });

  it("returns zero trust when no profile exists", () => {
    const result = store.get("player1", "unknown-npc", null, merchantPlayer);
    expect(result.trust).toBe(0);
    expect(result.disposition).toBe("wary");
  });

  it("clamps computed trust to [-1, 1]", () => {
    const extremeProfile: NpcProfile = {
      ...goranProfile,
      defaultTrust: -0.8,
      factionBias: { "thieves-guild": -0.5 },
    };
    const result = store.get("p1", "extreme", extremeProfile, thiefPlayer);
    expect(result.trust).toBe(-1.0);
  });
});

describe("RelationshipStore (SQL) — addObservation", () => {
  it("creates row on first observation", () => {
    const result = store.addObservation(
      "player1", "goran",
      {
        event: "helped-at-forge",
        timestamp: Date.now(),
        tags: ["cooperation"],
        delta: { trust: 0.15 },
        source: "manual",
      },
      goranProfile,
      merchantPlayer
    );
    // First contact: -0.1 + 0.3 = 0.2, then +0.15 = 0.35
    expect(result.trust).toBeCloseTo(0.35);
    expect(result.disposition).toBe("friendly");
  });

  it("accumulates observations over multiple calls", () => {
    store.addObservation("player1", "goran", {
      event: "trade", timestamp: 1, tags: ["trade"], delta: { trust: 0.1 }, source: "manual",
    }, goranProfile, merchantPlayer);

    store.addObservation("player1", "goran", {
      event: "trade-2", timestamp: 2, tags: ["trade"], delta: { trust: 0.1 }, source: "tag-rule",
    }, goranProfile, merchantPlayer);

    const rel = store.get("player1", "goran", goranProfile, merchantPlayer);
    expect(rel.familiarity).toBe(2);
    expect(rel.observations.length).toBe(2);
    expect(rel.trust).toBeCloseTo(0.4); // 0.2 + 0.1 + 0.1
  });

  it("clamps trust on negative delta overflow", () => {
    const result = store.addObservation(
      "player1", "goran",
      {
        event: "massive-betrayal",
        timestamp: Date.now(),
        tags: ["crime"],
        delta: { trust: -5.0 },
        source: "manual",
      },
      goranProfile,
      merchantPlayer
    );
    expect(result.trust).toBe(-1.0);
  });

  it("addObservation returns anchor as null when no anchor processing", () => {
    const result = store.addObservation(
      "player1", "goran-anchor-test",
      {
        event: "trade",
        timestamp: Date.now(),
        tags: ["trade"],
        delta: { trust: 0.1 },
        source: "manual",
      },
      goranProfile,
      merchantPlayer
    );
    expect(result.anchor).toBeNull();
  });
});

const goranProfileWithDecay: NpcProfile = {
  ...goranProfile,
  decayProfile: "normal",
  anchorConfig: {
    familiarityThreshold: 5,
    rivalThreshold: 0.3,
    depthIncrement: 0.15,
    passiveDepthCeiling: 0.3,
    passiveDepthRate: 0.01,
  },
};

describe("RelationshipStore (SQL) — trust decay at GET time", () => {
  it("applies trust decay based on time since last interaction", () => {
    store.addObservation("player1", "goran-decay", {
      event: "trade", timestamp: Date.now() - 60 * 86400_000,
      tags: ["trade"], delta: { trust: 0.3 }, source: "manual",
    }, goranProfileWithDecay, merchantPlayer);

    const rel = store.get("player1", "goran-decay", goranProfileWithDecay, merchantPlayer);
    expect(rel.trust).toBeCloseTo(0.5, 1);
  });

  it("sharp profile does not decay trust", () => {
    const sharpProfile: NpcProfile = { ...goranProfile, decayProfile: "sharp" };
    store.addObservation("player1", "sharp-npc", {
      event: "trade", timestamp: Date.now() - 365 * 86400_000,
      tags: ["trade"], delta: { trust: 0.3 }, source: "manual",
    }, sharpProfile, merchantPlayer);

    const rel = store.get("player1", "sharp-npc", sharpProfile, merchantPlayer);
    expect(rel.trust).toBeCloseTo(0.5, 1);
  });

  it("first-contact response includes anchor: null", () => {
    const rel = store.get("player1", "no-anchor-npc", goranProfile, merchantPlayer);
    expect(rel.anchor).toBeNull();
  });
});

describe("RelationshipStore (SQL) — anchor promotion", () => {
  it("promotes to friend anchor when familiarity threshold met + promote tag", () => {
    for (let i = 0; i < 5; i++) {
      store.addObservation("player1", "promote-npc", {
        event: `trade-${i}`, timestamp: Date.now(), tags: ["trade"],
        delta: { trust: 0.05 }, source: "manual",
      }, goranProfileWithDecay, merchantPlayer);
    }
    const promoteOutcome: AnchorOutcome = { shouldPromote: true, shouldBreak: false, minAnchorDepth: 0.6 };
    const result = store.addObservation("player1", "promote-npc", {
      event: "saved-my-life", timestamp: Date.now(), tags: ["saved-my-life"],
      delta: { trust: 0.4 }, source: "manual",
    }, goranProfileWithDecay, merchantPlayer, promoteOutcome);

    expect(result.anchor).not.toBeNull();
    expect(result.anchor!.state).toBe("friend");
    expect(result.anchor!.depth).toBeGreaterThanOrEqual(0.6);
  });

  it("does not promote when familiarity below threshold", () => {
    const promoteOutcome: AnchorOutcome = { shouldPromote: true, shouldBreak: false, minAnchorDepth: 0.6 };
    const result = store.addObservation("player1", "goran-low", {
      event: "saved-my-life", timestamp: Date.now(), tags: ["saved-my-life"],
      delta: { trust: 0.4 }, source: "manual",
    }, goranProfileWithDecay, merchantPlayer, promoteOutcome);

    expect(result.anchor).toBeNull();
  });
});

describe("RelationshipStore (SQL) — anchor breaking", () => {
  it("flips from friend to rival on break event with deep negative trust", () => {
    for (let i = 0; i < 5; i++) {
      store.addObservation("player1", "brother", {
        event: `bond-${i}`, timestamp: Date.now(), tags: ["trade"],
        delta: { trust: 0.05 }, source: "manual",
      }, goranProfileWithDecay, merchantPlayer);
    }
    const promoteOutcome: AnchorOutcome = { shouldPromote: true, shouldBreak: false, minAnchorDepth: 0.8 };
    store.addObservation("player1", "brother", {
      event: "sworn-oath", timestamp: Date.now(), tags: ["sworn-oath"],
      delta: { trust: 0.2 }, source: "manual",
    }, goranProfileWithDecay, merchantPlayer, promoteOutcome);

    let rel = store.get("player1", "brother", goranProfileWithDecay, merchantPlayer);
    expect(rel.anchor!.state).toBe("friend");

    const breakOutcome: AnchorOutcome = { shouldPromote: false, shouldBreak: true, minAnchorDepth: 0 };
    const result = store.addObservation("player1", "brother", {
      event: "betrayal", timestamp: Date.now(), tags: ["betrayal"],
      delta: { trust: -0.8 }, source: "manual",
    }, goranProfileWithDecay, merchantPlayer, breakOutcome);

    expect(result.anchor!.state).toBe("rival");
    expect(result.anchor!.depth).toBeGreaterThanOrEqual(0.8);
    expect(result.trust).toBeLessThan(-0.3);
  });
});

describe("RelationshipStore (SQL) — event amplification", () => {
  it("amplifies trust deltas for anchored relationships", () => {
    for (let i = 0; i < 5; i++) {
      store.addObservation("player1", "amp-npc", {
        event: `trade-${i}`, timestamp: Date.now(), tags: ["trade"],
        delta: { trust: 0.05 }, source: "manual",
      }, goranProfileWithDecay, merchantPlayer);
    }
    const promoteOutcome: AnchorOutcome = { shouldPromote: true, shouldBreak: false, minAnchorDepth: 0.5 };
    store.addObservation("player1", "amp-npc", {
      event: "sworn-oath", timestamp: Date.now(), tags: ["sworn-oath"],
      delta: { trust: 0.1 }, source: "manual",
    }, goranProfileWithDecay, merchantPlayer, promoteOutcome);

    const result = store.addObservation("player1", "amp-npc", {
      event: "big-trade", timestamp: Date.now(), tags: ["trade"],
      delta: { trust: 0.1 }, source: "manual",
    }, goranProfileWithDecay, merchantPlayer);

    expect(result.delta.trust).toBeCloseTo(0.175, 2);
  });
});

describe("RelationshipStore (SQL) — setAnchor (explicit)", () => {
  it("explicitly sets friend anchor", () => {
    store.addObservation("player1", "explicit-npc", {
      event: "meeting", timestamp: Date.now(), tags: [],
      delta: { trust: 0.3 }, source: "manual",
    }, goranProfileWithDecay, merchantPlayer);

    store.setAnchor("player1", "explicit-npc", "friend", 0.9, goranProfileWithDecay, merchantPlayer);
    const rel = store.get("player1", "explicit-npc", goranProfileWithDecay, merchantPlayer);
    expect(rel.anchor!.state).toBe("friend");
    expect(rel.anchor!.depth).toBe(0.9);
  });

  it("resets anchor to none", () => {
    store.addObservation("player1", "reset-npc", {
      event: "meeting", timestamp: Date.now(), tags: [],
      delta: { trust: 0.3 }, source: "manual",
    }, goranProfileWithDecay, merchantPlayer);

    store.setAnchor("player1", "reset-npc", "friend", 0.5, goranProfileWithDecay, merchantPlayer);
    store.setAnchor("player1", "reset-npc", "none", 0, goranProfileWithDecay, merchantPlayer);
    const rel = store.get("player1", "reset-npc", goranProfileWithDecay, merchantPlayer);
    expect(rel.anchor).toBeNull();
  });
});

describe("RelationshipStore (SQL) — two-player shared world", () => {
  it("two players have independent relationships with the same NPC", () => {
    store.addObservation("player1", "goran", {
      event: "helped", timestamp: Date.now(), tags: ["cooperation"], delta: { trust: 0.3 }, source: "manual",
    }, goranProfile, merchantPlayer);

    store.addObservation("player2", "goran", {
      event: "theft", timestamp: Date.now(), tags: ["crime"], delta: { trust: -0.4 }, source: "manual",
    }, goranProfile, unknownPlayer);

    const rel1 = store.get("player1", "goran", goranProfile, merchantPlayer);
    const rel2 = store.get("player2", "goran", goranProfile, unknownPlayer);

    expect(rel1.trust).toBeCloseTo(0.5, 1);  // 0.2 + 0.3
    expect(rel2.trust).toBeCloseTo(-0.5, 1); // -0.1 + (-0.4)
  });
});
