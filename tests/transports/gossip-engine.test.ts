import { describe, it, expect } from "vitest";
import { rollDisclosure } from "../../src/transports/gossip-engine.js";

describe("gossip-engine.rollDisclosure", () => {
  it("returns no-propagate-tag-match when memory tags don't intersect propagateTags", () => {
    const out = rollDisclosure({
      discloserTrait: "normal",
      discloserTrustToListener: 50,
      discloserTrustToSubject: 50,
      memoryTags: ["mundane"],
      propagateTags: ["confession", "rumor"],
      alreadyHearsay: false,
      seed: 1,
    });
    expect(out.disclosed).toBe(false);
    expect(out.reason).toBe("no-propagate-tag-match");
  });

  it("returns already-hearsay when memory is already second-hand", () => {
    const out = rollDisclosure({
      discloserTrait: "gossipy",
      discloserTrustToListener: 100,
      discloserTrustToSubject: 0,
      memoryTags: ["confession"],
      propagateTags: ["confession"],
      alreadyHearsay: true,
      seed: 1,
    });
    expect(out.disclosed).toBe(false);
    expect(out.reason).toBe("already-hearsay");
  });

  it("is deterministic under a fixed seed", () => {
    const input = {
      discloserTrait: "normal" as const,
      discloserTrustToListener: 50,
      discloserTrustToSubject: 50,
      memoryTags: ["rumor"],
      propagateTags: ["rumor"],
      alreadyHearsay: false,
      seed: 42,
    };
    const a = rollDisclosure(input);
    const b = rollDisclosure(input);
    expect(a.roll).toBe(b.roll);
    expect(a.disclosed).toBe(b.disclosed);
  });

  it("gossipy + high trust to listener nearly always discloses non-sensitive rumor", () => {
    let successes = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const out = rollDisclosure({
        discloserTrait: "gossipy",
        discloserTrustToListener: 100,
        discloserTrustToSubject: 0,
        memoryTags: ["rumor"],
        propagateTags: ["rumor"],
        alreadyHearsay: false,
        seed,
      });
      if (out.disclosed) successes++;
    }
    expect(successes).toBeGreaterThan(85);
  });

  it("discreet + low trust to listener rarely discloses", () => {
    let successes = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const out = rollDisclosure({
        discloserTrait: "discreet",
        discloserTrustToListener: 0,
        discloserTrustToSubject: 100,
        memoryTags: ["confession"],
        propagateTags: ["confession"],
        alreadyHearsay: false,
        seed,
      });
      if (out.disclosed) successes++;
    }
    expect(successes).toBeLessThan(15);
  });

  it("juicy tag lowers DC; secret tag raises it", () => {
    const juicy = rollDisclosure({
      discloserTrait: "normal",
      discloserTrustToListener: 50,
      discloserTrustToSubject: 50,
      memoryTags: ["rumor", "juicy"],
      propagateTags: ["rumor"],
      alreadyHearsay: false,
      seed: 7,
    });
    const secret = rollDisclosure({
      discloserTrait: "normal",
      discloserTrustToListener: 50,
      discloserTrustToSubject: 50,
      memoryTags: ["rumor", "secret"],
      propagateTags: ["rumor"],
      alreadyHearsay: false,
      seed: 7,
    });
    expect(juicy.dc).toBeLessThan(secret.dc);
  });

  it("reports roll, dc, and modifiers in the outcome", () => {
    const out = rollDisclosure({
      discloserTrait: "gossipy",
      discloserTrustToListener: 80,
      discloserTrustToSubject: 20,
      memoryTags: ["rumor"],
      propagateTags: ["rumor"],
      alreadyHearsay: false,
      seed: 123,
    });
    expect(out.roll).toBeGreaterThanOrEqual(1);
    expect(out.roll).toBeLessThanOrEqual(20);
    expect(out.dc).toBeGreaterThan(0);
    expect(out.modifiers).toHaveProperty("trait");
    expect(out.modifiers).toHaveProperty("trustListener");
    expect(out.modifiers).toHaveProperty("trustSubject");
  });
});
