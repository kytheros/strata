import { describe, it, expect } from "vitest";
import {
  computeTrustDelta,
  computeAnchorOutcome,
  clampTrust,
  trustToDisposition,
  DEFAULT_ANCHOR_TAGS,
} from "../../src/transports/tag-rule-engine.js";

describe("tag-rule engine — computeTrustDelta", () => {
  it("lawful NPC penalizes theft heavily", () => {
    const delta = computeTrustDelta(
      ["theft"],
      { ethical: "lawful", moral: "neutral" }
    );
    expect(delta.trust).toBe(-0.4);
  });

  it("chaotic NPC barely notices theft", () => {
    const delta = computeTrustDelta(
      ["theft"],
      { ethical: "chaotic", moral: "neutral" }
    );
    expect(delta.trust).toBe(-0.05);
  });

  it("good NPC rewards cooperation more (1.2x multiplier)", () => {
    const delta = computeTrustDelta(
      ["cooperation"],
      { ethical: "lawful", moral: "good" }
    );
    expect(delta.trust).toBe(0.18); // 0.15 * 1.2
  });

  it("evil NPC is less affected by everything (0.8x)", () => {
    const delta = computeTrustDelta(
      ["theft"],
      { ethical: "lawful", moral: "evil" }
    );
    expect(delta.trust).toBe(-0.32); // -0.4 * 0.8
  });

  it("multiple tags stack additively", () => {
    const delta = computeTrustDelta(
      ["theft", "violence"],
      { ethical: "lawful", moral: "neutral" }
    );
    expect(delta.trust).toBe(-0.7); // -0.4 + -0.3
  });

  it("unknown tags produce zero delta", () => {
    const delta = computeTrustDelta(
      ["unknown-tag", "also-unknown"],
      { ethical: "lawful", moral: "good" }
    );
    expect(delta.trust).toBe(0);
  });

  it("per-NPC tagRules override defaults", () => {
    const delta = computeTrustDelta(
      ["theft"],
      { ethical: "lawful", moral: "neutral" },
      { theft: { trust: -0.05 } } // corrupt guard
    );
    expect(delta.trust).toBe(-0.05);
  });

  it("per-NPC tagRules still get moral multiplier", () => {
    const delta = computeTrustDelta(
      ["bribery"],
      { ethical: "lawful", moral: "good" },
      { bribery: { trust: 0.2 } }
    );
    expect(delta.trust).toBe(0.24); // 0.2 * 1.2
  });

  it("tags are case-insensitive", () => {
    const delta = computeTrustDelta(
      ["THEFT", "Violence"],
      { ethical: "lawful", moral: "neutral" }
    );
    expect(delta.trust).toBe(-0.7);
  });
});

describe("tag-rule engine — clampTrust", () => {
  it("clamps above 1.0", () => expect(clampTrust(1.5)).toBe(1.0));
  it("clamps below -1.0", () => expect(clampTrust(-1.5)).toBe(-1.0));
  it("passes through values in range", () => expect(clampTrust(0.5)).toBe(0.5));
});

describe("tag-rule engine — trustToDisposition", () => {
  it("hostile below -0.5", () => expect(trustToDisposition(-0.7)).toBe("hostile"));
  it("suspicious between -0.5 and 0", () => expect(trustToDisposition(-0.2)).toBe("suspicious"));
  it("wary between 0 and 0.3", () => expect(trustToDisposition(0.15)).toBe("wary"));
  it("friendly between 0.3 and 0.7", () => expect(trustToDisposition(0.5)).toBe("friendly"));
  it("devoted above 0.7", () => expect(trustToDisposition(0.85)).toBe("devoted"));
});

describe("tag-rule engine — anchor tag trust fallback", () => {
  it("saved-my-life produces +0.4 delta via anchor tag fallback", () => {
    const delta = computeTrustDelta(
      ["saved-my-life"],
      { ethical: "neutral", moral: "neutral" }
    );
    expect(delta.trust).toBe(0.4);
  });

  it("betrayal produces -0.5 delta via anchor tag fallback", () => {
    const delta = computeTrustDelta(
      ["betrayal"],
      { ethical: "neutral", moral: "neutral" }
    );
    expect(delta.trust).toBe(-0.5);
  });

  it("anchor tag trust still gets moral multiplier", () => {
    const delta = computeTrustDelta(
      ["saved-my-life"],
      { ethical: "neutral", moral: "good" }
    );
    expect(delta.trust).toBe(0.48); // 0.4 * 1.2
  });
});

describe("tag-rule engine — computeAnchorOutcome", () => {
  it("returns shouldPromote for saved-my-life tag", () => {
    const outcome = computeAnchorOutcome(["saved-my-life"]);
    expect(outcome.shouldPromote).toBe(true);
    expect(outcome.shouldBreak).toBe(false);
    expect(outcome.minAnchorDepth).toBe(0.6);
  });

  it("returns shouldBreak for betrayal tag", () => {
    const outcome = computeAnchorOutcome(["betrayal"]);
    expect(outcome.shouldPromote).toBe(false);
    expect(outcome.shouldBreak).toBe(true);
  });

  it("per-NPC tagRules override default anchor tags", () => {
    const outcome = computeAnchorOutcome(
      ["custom-bond"],
      { "custom-bond": { trust: 0.2, promoteAnchor: true, minAnchorDepth: 0.7 } }
    );
    expect(outcome.shouldPromote).toBe(true);
    expect(outcome.minAnchorDepth).toBe(0.7);
  });

  it("returns no anchor outcome for unknown tags", () => {
    const outcome = computeAnchorOutcome(["trade", "cooperation"]);
    expect(outcome.shouldPromote).toBe(false);
    expect(outcome.shouldBreak).toBe(false);
  });

  it("both promote and break can be true simultaneously (break wins in processing)", () => {
    const outcome = computeAnchorOutcome(["saved-my-life", "betrayal"]);
    expect(outcome.shouldPromote).toBe(true);
    expect(outcome.shouldBreak).toBe(true);
  });

  it("takes highest minAnchorDepth across multiple promote tags", () => {
    const outcome = computeAnchorOutcome(["shared-trauma", "family-bond"]);
    expect(outcome.minAnchorDepth).toBe(0.8); // family-bond has 0.8, shared-trauma has 0.4
  });
});

describe("tag-rule engine — DEFAULT_ANCHOR_TAGS", () => {
  it("includes promote tags", () => {
    expect(DEFAULT_ANCHOR_TAGS["saved-my-life"].promoteAnchor).toBe(true);
    expect(DEFAULT_ANCHOR_TAGS["sworn-oath"].promoteAnchor).toBe(true);
    expect(DEFAULT_ANCHOR_TAGS["family-bond"].promoteAnchor).toBe(true);
  });

  it("includes break tags", () => {
    expect(DEFAULT_ANCHOR_TAGS["betrayal"].breakAnchor).toBe(true);
    expect(DEFAULT_ANCHOR_TAGS["murder"].breakAnchor).toBe(true);
    expect(DEFAULT_ANCHOR_TAGS["oath-breaking"].breakAnchor).toBe(true);
  });
});
