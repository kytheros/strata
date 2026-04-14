import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NpcAcquaintanceStore } from "../../src/transports/npc-acquaintance-store.js";

describe("NpcAcquaintanceStore", () => {
  let baseDir: string;
  let store: NpcAcquaintanceStore;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "acq-"));
    store = new NpcAcquaintanceStore(baseDir);
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("returns null when no card exists", () => {
    expect(store.get("default", "goran", "brynn")).toBeNull();
  });

  it("recordInteraction creates card if missing with defaults", () => {
    const card = store.recordInteraction("default", "goran", "brynn");
    expect(card.trust).toBe(50);
    expect(card.interactionCount).toBe(1);
    expect(card.lastInteractionAt).toBeGreaterThan(0);
  });

  it("recordInteraction increments interactionCount on existing card", () => {
    store.recordInteraction("default", "goran", "brynn");
    const card = store.recordInteraction("default", "goran", "brynn");
    expect(card.interactionCount).toBe(2);
  });

  it("updateTrust clamps to 0..100", () => {
    store.recordInteraction("default", "goran", "brynn");
    store.updateTrust("default", "goran", "brynn", 200);
    expect(store.get("default", "goran", "brynn")?.trust).toBe(100);
    store.updateTrust("default", "goran", "brynn", -500);
    expect(store.get("default", "goran", "brynn")?.trust).toBe(0);
  });

  it("persists across store instances", () => {
    store.recordInteraction("default", "goran", "brynn");
    const fresh = new NpcAcquaintanceStore(baseDir);
    const card = fresh.get("default", "goran", "brynn");
    expect(card?.interactionCount).toBe(1);
  });

  it("separate cards per (npc, otherNpc) pair", () => {
    store.recordInteraction("default", "goran", "brynn");
    store.recordInteraction("default", "goran", "mira");
    expect(store.get("default", "goran", "brynn")?.interactionCount).toBe(1);
    expect(store.get("default", "goran", "mira")?.interactionCount).toBe(1);
  });
});
