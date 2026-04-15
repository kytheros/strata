import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../src/transports/world-schema.js";
import { NpcAcquaintanceStore } from "../../src/transports/npc-acquaintance-store.js";

describe("NpcAcquaintanceStore (SQL)", () => {
  let db: Database.Database;
  let store: NpcAcquaintanceStore;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    store = new NpcAcquaintanceStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns null when no card exists", () => {
    expect(store.get("goran", "brynn")).toBeNull();
  });

  it("recordInteraction creates card if missing with defaults", () => {
    const card = store.recordInteraction("goran", "brynn");
    expect(card.trust).toBe(50);
    expect(card.interactionCount).toBe(1);
    expect(card.lastInteractionAt).toBeGreaterThan(0);
  });

  it("recordInteraction increments interactionCount on existing card", () => {
    store.recordInteraction("goran", "brynn");
    const card = store.recordInteraction("goran", "brynn");
    expect(card.interactionCount).toBe(2);
  });

  it("updateTrust clamps to 0..100", () => {
    store.recordInteraction("goran", "brynn");
    store.updateTrust("goran", "brynn", 200);
    expect(store.get("goran", "brynn")?.trust).toBe(100);
    store.updateTrust("goran", "brynn", -500);
    expect(store.get("goran", "brynn")?.trust).toBe(0);
  });

  it("persists across store instances sharing same db", () => {
    store.recordInteraction("goran", "brynn");
    const fresh = new NpcAcquaintanceStore(db);
    const card = fresh.get("goran", "brynn");
    expect(card?.interactionCount).toBe(1);
  });

  it("separate cards per (npc, otherNpc) pair", () => {
    store.recordInteraction("goran", "brynn");
    store.recordInteraction("goran", "mira");
    expect(store.get("goran", "brynn")?.interactionCount).toBe(1);
    expect(store.get("goran", "mira")?.interactionCount).toBe(1);
  });

  it("acquaintances are world-shared: no playerId scope", () => {
    // Both 'players' see the same NPC-level acquaintance data
    store.recordInteraction("goran", "brynn");
    const card = store.get("goran", "brynn");
    expect(card?.interactionCount).toBe(1);
    // A second store on the same db sees the same data
    const store2 = new NpcAcquaintanceStore(db);
    expect(store2.get("goran", "brynn")?.interactionCount).toBe(1);
  });

  it("updateTrust is a no-op when card does not exist", () => {
    expect(() => store.updateTrust("goran", "nobody", 10)).not.toThrow();
    expect(store.get("goran", "nobody")).toBeNull();
  });
});
