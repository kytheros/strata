import { describe, it, expect } from "vitest";
import { CONFIG } from "../src/config.js";

describe("CONFIG — TIR+QDP community port additions (TIRQDP-1.6)", () => {
  it("exposes search.useTirQdp default false", () => {
    expect(CONFIG.search.useTirQdp).toBe(false);
  });

  it("exposes recall.communityQdp with NPC-parity defaults", () => {
    expect(CONFIG.recall.communityQdp).toBeDefined();
    expect(CONFIG.recall.communityQdp.dedupeJaccard).toBe(0.85);
    expect(CONFIG.recall.communityQdp.fillerMaxLen).toBe(40);
    expect(CONFIG.recall.communityQdp.minTokenLen).toBe(4);
  });

  it("did not replace the pre-existing recall.qdp block (additive guarantee)", () => {
    expect(CONFIG.recall.qdp).toBeDefined();
    expect(CONFIG.recall.qdp.dedupeJaccard).toBe(0.85);
    expect(CONFIG.recall.qdp.fillerMaxLen).toBe(40);
    expect(CONFIG.recall.qdp.minTokenLen).toBe(4);
  });
});
