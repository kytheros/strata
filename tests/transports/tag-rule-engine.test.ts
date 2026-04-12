import { describe, it, expect } from "vitest";
import {
  computeTrustDelta,
  clampTrust,
  trustToDisposition,
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
