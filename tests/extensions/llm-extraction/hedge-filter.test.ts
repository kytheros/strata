import { describe, expect, test } from "vitest";
import {
  detectHedge,
  rewriteAsRumor,
  applyHedgeFilter,
} from "../../../src/extensions/llm-extraction/hedge-filter.js";
import type { AtomicFact } from "../../../src/extensions/llm-extraction/utterance-extractor.js";

const HEDGE_PHRASES = [
  "I've heard there are bandits.",
  "There's talk of a new lord.",
  "Rumored to be haunted.",
  "I haven't seen any reports.",
  "Not sure if that's true.",
  "Might be a storm coming.",
  "Supposedly the well is cursed.",
  "Word is the tax collector is back.",
  "They say the mines are empty.",
  "Some say he never returned.",
  "I hear the road is blocked.",
  "Allegedly stolen from the chapel.",
  "Believed to be a ghost story.",
  "Said to be a fair trade.",
  "Whispers of betrayal at court.",
  "I've heard tell of a dragon.",
  "Rumors of a plague in the south.",
  "Folks say the harvest failed.",
  "Word has it she's returned.",
  "There is rumor of a thief.",
];

const PLAIN_ASSERTIONS = [
  "Goran is the village blacksmith.",
  "The inn closes at midnight.",
  "Mira trades willow bark for iron.",
  "I sell iron nails.",
  "The forge fire is hot.",
  "Player asked about the well.",
  "Brynn runs the Wayfarer's Rest.",
  "The oak tree by the road is old.",
  "He paid in silver.",
  "She left at dawn.",
  "The gate is locked.",
  "I fixed the hinges yesterday.",
  "The bread is fresh.",
  "Goran has worked the forge for twenty years.",
  "The mill wheel turns steadily.",
  "The player bought two ales.",
  "Rain fell for three days.",
  "The cart broke an axle.",
  "I charge two coppers for a candle.",
  "Mira closed her stall at dusk.",
];

describe("detectHedge", () => {
  for (const phrase of HEDGE_PHRASES) {
    test(`detects hedge: "${phrase}"`, () => {
      expect(detectHedge(phrase)).toBe(true);
    });
  }
  for (const phrase of PLAIN_ASSERTIONS) {
    test(`does not flag plain: "${phrase}"`, () => {
      expect(detectHedge(phrase)).toBe(false);
    });
  }
  test("case-insensitive", () => {
    expect(detectHedge("THERE'S TALK of bandits")).toBe(true);
    expect(detectHedge("there's talk of bandits")).toBe(true);
  });
});

describe("rewriteAsRumor", () => {
  test("empty string passes through", () => {
    expect(rewriteAsRumor("")).toBe("");
    expect(rewriteAsRumor("   ")).toBe("");
  });
  test("prepends rumor framing to plain text", () => {
    expect(rewriteAsRumor("bandits are near Blackwood")).toBe(
      "it is rumored that bandits are near Blackwood",
    );
  });
  test("is idempotent on already-framed text (it is rumored)", () => {
    const already = "it is rumored that bandits are near Blackwood";
    expect(rewriteAsRumor(already)).toBe(already);
  });
  test("is idempotent on there-is-rumor prefix", () => {
    const already = "there is rumor of bandits near Blackwood";
    expect(rewriteAsRumor(already)).toBe(already);
  });
  test("is idempotent on word-has-it prefix", () => {
    const already = "word has it the inn is closed";
    expect(rewriteAsRumor(already)).toBe(already);
  });
});

describe("applyHedgeFilter", () => {
  const baseFact: AtomicFact = {
    text: "bandits are near Blackwood Forest",
    type: "semantic",
    importance: 70,
  };

  test("downgrades when source text contains a hedge", () => {
    const out = applyHedgeFilter([baseFact], "There's talk of bandits.");
    expect(out).toHaveLength(1);
    expect(out[0].tags).toContain("hearsay");
    expect(out[0].importance).toBeLessThanOrEqual(40);
    expect(out[0].text.startsWith("it is rumored") || out[0].text.startsWith("there is rumor"))
      .toBe(true);
  });

  test("downgrades when fact.hearsay === true regardless of source", () => {
    const flagged: AtomicFact = { ...baseFact, hearsay: true };
    const out = applyHedgeFilter([flagged], "Plain assertion without hedge markers.");
    expect(out[0].tags).toContain("hearsay");
    expect(out[0].importance).toBeLessThanOrEqual(40);
  });

  test("passes non-hedged facts through unchanged", () => {
    const out = applyHedgeFilter([baseFact], "Goran is the blacksmith.");
    expect(out[0].tags ?? []).not.toContain("hearsay");
    expect(out[0].importance).toBe(70);
    expect(out[0].text).toBe(baseFact.text);
  });

  test("does not duplicate hearsay tag if already present", () => {
    const prior: AtomicFact = { ...baseFact, tags: ["hearsay"] };
    const out = applyHedgeFilter([prior], "rumored to be true");
    expect(out[0].tags!.filter((t) => t === "hearsay")).toHaveLength(1);
  });

  test("respects STRATA_HEARSAY_IMPORTANCE_CEIL env override", () => {
    process.env.STRATA_HEARSAY_IMPORTANCE_CEIL = "20";
    try {
      const out = applyHedgeFilter([baseFact], "there's talk of bandits");
      expect(out[0].importance).toBeLessThanOrEqual(20);
    } finally {
      delete process.env.STRATA_HEARSAY_IMPORTANCE_CEIL;
    }
  });

  test("passes through an unexpected fact shape without throwing", () => {
    const weird = { text: "x", type: "semantic" } as AtomicFact;
    expect(() => applyHedgeFilter([weird], "rumored")).not.toThrow();
  });
});
