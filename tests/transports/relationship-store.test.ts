import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelationshipStore } from "../../src/transports/relationship-store.js";
import type { NpcProfile } from "../../src/transports/npc-profile-store.js";
import type { CharacterCard } from "../../src/transports/character-store.js";

let baseDir: string;
let store: RelationshipStore;

const goranProfile: NpcProfile = {
  name: "Goran",
  alignment: { ethical: "lawful", moral: "good" },
  faction: "millhaven-merchants",
  traits: ["honest"],
  backstory: "Runs the forge.",
  defaultTrust: -0.1,
  factionBias: { "millhaven-merchants": 0.3, "thieves-guild": -0.4 },
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
  baseDir = mkdtempSync(join(tmpdir(), "strata-relationship-test-"));
  store = new RelationshipStore(baseDir);
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe("RelationshipStore — first-contact computation", () => {
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
    expect(result.trust).toBeCloseTo(-0.5); // -0.1 + (-0.4)
    // -0.5 is the boundary: hostile is trust < -0.5 (exclusive), so -0.5 is "suspicious"
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
    expect(result.trust).toBe(-1.0); // clamped from -1.3
  });
});

describe("RelationshipStore — addObservation", () => {
  it("creates file on first observation", () => {
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
});
