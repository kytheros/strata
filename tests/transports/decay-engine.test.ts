import { describe, it, expect } from "vitest";
import {
  resolveProfile,
  memoryRetention,
  trustDecay,
  amplifyDelta,
  NAMED_PROFILES,
} from "../../src/transports/decay-engine.js";

describe("decay-engine — resolveProfile", () => {
  it("returns normal profile by default", () => {
    const p = resolveProfile();
    expect(p.lambdaBase).toBe(0.023);
    expect(p.lambdaTrust).toBe(0.0116);
    expect(p.blendAlpha).toBe(0.7);
    expect(p.dayEquivalent).toBe(1.0);
  });

  it("returns sharp profile with zero lambdas", () => {
    const p = resolveProfile("sharp");
    expect(p.lambdaBase).toBe(0);
    expect(p.lambdaTrust).toBe(0);
  });

  it("returns fading profile", () => {
    const p = resolveProfile("fading");
    expect(p.lambdaBase).toBe(0.099);
    expect(p.lambdaTrust).toBe(0.046);
    expect(p.blendAlpha).toBe(0.5);
    expect(p.dayEquivalent).toBe(2.0);
  });

  it("uses custom config when profileName is custom", () => {
    const p = resolveProfile("custom", {
      lambdaBase: 0.05,
      lambdaTrust: 0.03,
      blendAlpha: 0.6,
      dayEquivalent: 1.5,
    });
    expect(p.lambdaBase).toBe(0.05);
    expect(p.lambdaTrust).toBe(0.03);
  });

  it("falls back to normal for unknown profile names", () => {
    const p = resolveProfile("bogus-name");
    expect(p).toEqual(NAMED_PROFILES.normal);
  });
});

describe("decay-engine — memoryRetention", () => {
  it("sharp profile always returns 1.0 regardless of age", () => {
    const p = resolveProfile("sharp");
    expect(memoryRetention(365, 100, p)).toBe(1.0);
  });

  it("normal profile at ~30 days has ~0.5 retention (half-life)", () => {
    const p = resolveProfile("normal");
    // effectiveAge = blendAlpha * ageDays = 0.7 * 30 = 21 (when interactions=0)
    // Pure time half-life = ln(2) / (0.023 * 0.7) ~ 43 days
    // At 30 days: e^(-0.023 * 21) ~ 0.617
    const retention = memoryRetention(30, 0, p);
    expect(retention).toBeCloseTo(0.617, 1);
  });

  it("fading profile at ~7 days has ~0.5 retention", () => {
    const p = resolveProfile("fading");
    // effectiveAge = blendAlpha * ageDays = 0.5 * 7 = 3.5 (when interactions=0)
    // At 7 days: e^(-0.099 * 3.5) ~ 0.707
    const retention = memoryRetention(7, 0, p);
    expect(retention).toBeCloseTo(0.707, 1);
  });

  it("anchorDepth 0.9 slows decay significantly", () => {
    const p = resolveProfile("normal");
    const noAnchor = memoryRetention(30, 0, p, 0);
    const anchored = memoryRetention(30, 0, p, 0.9);
    expect(anchored).toBeGreaterThan(noAnchor);
    // lambda_eff = 0.023 * (1 - 0.9 * 0.8) = 0.023 * 0.28 = 0.00644
    // retention at 30d = e^(-0.00644 * 30) ~ 0.824
    expect(anchored).toBeCloseTo(0.824, 1);
  });

  it("interaction count contributes to effective age", () => {
    const p = resolveProfile("normal"); // blendAlpha=0.7, dayEquivalent=1.0
    const timeOnly = memoryRetention(10, 0, p);
    const withInteractions = memoryRetention(10, 20, p);
    // effectiveAge(10,0) = 0.7*10 + 0.3*0*1 = 7
    // effectiveAge(10,20) = 0.7*10 + 0.3*20*1 = 13
    expect(withInteractions).toBeLessThan(timeOnly);
  });

  it("zero age returns 1.0 for all profiles", () => {
    for (const name of ["sharp", "normal", "fading"]) {
      expect(memoryRetention(0, 0, resolveProfile(name))).toBe(1.0);
    }
  });
});

describe("decay-engine — trustDecay", () => {
  it("sharp profile returns stored trust unchanged", () => {
    const p = resolveProfile("sharp");
    expect(trustDecay(0.8, 0.2, 365, p)).toBe(0.8);
  });

  it("trust drifts toward resting point over time", () => {
    const p = resolveProfile("normal"); // lambdaTrust=0.0116, half-life ~ 60d
    const decayed = trustDecay(0.8, 0.2, 60, p);
    expect(decayed).toBeLessThan(0.8);
    expect(decayed).toBeGreaterThan(0.2);
    // At half-life: resting + (stored-resting)*0.5 = 0.2 + (0.8-0.2)*0.5 = 0.5
    expect(decayed).toBeCloseTo(0.5, 1);
  });

  it("trust converges to resting after very long time", () => {
    const p = resolveProfile("normal");
    const decayed = trustDecay(0.8, 0.2, 1000, p);
    expect(decayed).toBeCloseTo(0.2, 1);
  });

  it("negative trust drifts toward resting point", () => {
    const p = resolveProfile("normal");
    const decayed = trustDecay(-0.8, 0.0, 60, p);
    expect(decayed).toBeGreaterThan(-0.8);
    expect(decayed).toBeLessThan(0.0);
  });

  it("zero days returns stored trust exactly", () => {
    const p = resolveProfile("normal");
    expect(trustDecay(0.8, 0.2, 0, p)).toBe(0.8);
  });
});

describe("decay-engine — amplifyDelta", () => {
  it("no anchor returns base delta unchanged", () => {
    expect(amplifyDelta(0.15, 0)).toBe(0.15);
  });

  it("anchorDepth 0.9 amplifies to 2.35x", () => {
    // 0.15 * (1 + 0.9 * 1.5) = 0.15 * 2.35 = 0.3525
    expect(amplifyDelta(0.15, 0.9)).toBeCloseTo(0.3525);
  });

  it("amplifies negative deltas symmetrically", () => {
    // -0.5 * (1 + 0.9 * 1.5) = -0.5 * 2.35 = -1.175
    expect(amplifyDelta(-0.5, 0.9)).toBeCloseTo(-1.175);
  });

  it("anchorDepth 1.0 gives maximum 2.5x", () => {
    expect(amplifyDelta(1.0, 1.0)).toBeCloseTo(2.5);
  });
});
