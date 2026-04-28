import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../src/transports/world-schema.js";
import { NpcMemoryEngine } from "../../src/transports/npc-memory-engine.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  applySchema(db);
});

afterEach(() => {
  db.close();
});

describe("NpcMemoryEngine", () => {
  it("add + get round-trips a memory", () => {
    const engine = new NpcMemoryEngine(db, "goran");
    const id = engine.add({ content: "Helped the player fix the forge.", tags: ["cooperation"], importance: 70 });
    expect(typeof id).toBe("string");
    const mem = engine.getById(id);
    expect(mem).not.toBeNull();
    expect(mem!.content).toBe("Helped the player fix the forge.");
    expect(mem!.tags).toEqual(["cooperation"]);
    expect(mem!.importance).toBe(70);
    expect(mem!.npcId).toBe("goran");
  });

  it("getAll returns only memories for this npcId", () => {
    const goran = new NpcMemoryEngine(db, "goran");
    const brynn = new NpcMemoryEngine(db, "brynn");
    goran.add({ content: "Goran memory", tags: [], importance: 50 });
    brynn.add({ content: "Brynn memory", tags: [], importance: 50 });
    const goranMems = goran.getAll();
    expect(goranMems.length).toBe(1);
    expect(goranMems[0].content).toBe("Goran memory");
    const brynnMems = brynn.getAll();
    expect(brynnMems.length).toBe(1);
    expect(brynnMems[0].content).toBe("Brynn memory");
  });

  it("search returns matching memories via FTS5", () => {
    const engine = new NpcMemoryEngine(db, "goran");
    engine.add({ content: "Player helped me repair the anvil.", tags: ["cooperation"], importance: 60 });
    engine.add({ content: "Player stole a horseshoe from the shop.", tags: ["theft"], importance: 80 });
    const results = engine.search("anvil");
    expect(results.length).toBe(1);
    expect(results[0].content).toContain("anvil");
  });

  it("search is scoped to npcId (no cross-NPC leakage)", () => {
    const goran = new NpcMemoryEngine(db, "goran");
    const brynn = new NpcMemoryEngine(db, "brynn");
    goran.add({ content: "Goran knows about the sword.", tags: [], importance: 50 });
    brynn.add({ content: "Brynn knows about the shield.", tags: [], importance: 50 });
    // Brynn searching for "sword" should not see Goran's memory
    expect(brynn.search("sword")).toHaveLength(0);
    expect(goran.search("shield")).toHaveLength(0);
  });

  it("delete removes a memory", () => {
    const engine = new NpcMemoryEngine(db, "goran");
    const id = engine.add({ content: "Temporary memory", tags: [], importance: 50 });
    expect(engine.getAll().length).toBe(1);
    engine.delete(id);
    expect(engine.getAll().length).toBe(0);
    expect(engine.getById(id)).toBeNull();
  });

  it("delete is a no-op for unknown id", () => {
    const engine = new NpcMemoryEngine(db, "goran");
    expect(() => engine.delete("no-such-id")).not.toThrow();
  });

  it("add increments access_count on getById", () => {
    const engine = new NpcMemoryEngine(db, "goran");
    const id = engine.add({ content: "Access tracking test", tags: [], importance: 50 });
    const before = engine.getById(id)!;
    expect(before.accessCount).toBe(0);
    engine.recordAccess(id);
    const after = engine.getById(id)!;
    expect(after.accessCount).toBe(1);
  });

  it("add with anchorDepth stores and retrieves it", () => {
    const engine = new NpcMemoryEngine(db, "goran");
    const id = engine.add({ content: "Anchored memory", tags: ["bond"], importance: 90, anchorDepth: 3 });
    const mem = engine.getById(id)!;
    expect(mem.anchorDepth).toBe(3);
  });

  it("getAll returns memories ordered by importance desc", () => {
    const engine = new NpcMemoryEngine(db, "goran");
    engine.add({ content: "Low importance", tags: [], importance: 20 });
    engine.add({ content: "High importance", tags: [], importance: 90 });
    engine.add({ content: "Mid importance", tags: [], importance: 50 });
    const mems = engine.getAll();
    expect(mems[0].importance).toBe(90);
    expect(mems[1].importance).toBe(50);
    expect(mems[2].importance).toBe(20);
  });

  it("count returns number of memories for npcId", () => {
    const engine = new NpcMemoryEngine(db, "goran");
    expect(engine.count()).toBe(0);
    engine.add({ content: "First", tags: [], importance: 50 });
    engine.add({ content: "Second", tags: [], importance: 50 });
    expect(engine.count()).toBe(2);
  });
});

describe("NpcMemoryEngine — conflict resolution (Spec 2026-04-28)", () => {
  let db2: Database.Database;
  let engine: NpcMemoryEngine;

  beforeEach(() => {
    db2 = new Database(":memory:");
    applySchema(db2);
    engine = new NpcMemoryEngine(db2, "goran");
  });

  afterEach(() => {
    db2.close();
  });

  it("add() persists subjectKey and predicateKey when provided", () => {
    const id = engine.add({
      content: "player's current horse is Shadowfax",
      tags: ["extracted", "semantic"],
      importance: 70,
      subjectKey: "player",
      predicateKey: "current_hors",
    });
    const row = db2.prepare("SELECT subject_key, predicate_key, superseded_by FROM npc_memories WHERE memory_id=?").get(id) as Record<string, unknown>;
    expect(row.subject_key).toBe("player");
    expect(row.predicate_key).toBe("current_hors");
    expect(row.superseded_by).toBeNull();
  });

  it("add() leaves keys NULL when caller does not supply them (backward compat)", () => {
    const id = engine.add({
      content: "a fact with no keys",
      tags: [],
      importance: 50,
    });
    const row = db2.prepare("SELECT subject_key, predicate_key FROM npc_memories WHERE memory_id=?").get(id) as Record<string, unknown>;
    expect(row.subject_key).toBeNull();
    expect(row.predicate_key).toBeNull();
  });

  it("markSupersededByKey() updates prior matching rows and returns affected count", () => {
    const id1 = engine.add({ content: "horse is Silvermist", tags: [], importance: 70, subjectKey: "player", predicateKey: "current_hors" });
    const id2 = engine.add({ content: "horse is Shadowfax",  tags: [], importance: 70, subjectKey: "player", predicateKey: "current_hors" });
    const affected = engine.markSupersededByKey({
      npcId: "goran",
      subjectKey: "player",
      predicateKey: "current_hors",
      excludeId: id2,
      supersededBy: id2,
    });
    expect(affected).toBe(1);
    const row1 = db2.prepare("SELECT superseded_by FROM npc_memories WHERE memory_id=?").get(id1) as Record<string, unknown>;
    const row2 = db2.prepare("SELECT superseded_by FROM npc_memories WHERE memory_id=?").get(id2) as Record<string, unknown>;
    expect(row1.superseded_by).toBe(id2);
    expect(row2.superseded_by).toBeNull();
  });

  it("markSupersededByKey() is idempotent — second call returns 0", () => {
    const id1 = engine.add({ content: "a", tags: [], importance: 70, subjectKey: "player", predicateKey: "current_hors" });
    const id2 = engine.add({ content: "b", tags: [], importance: 70, subjectKey: "player", predicateKey: "current_hors" });
    engine.markSupersededByKey({ npcId: "goran", subjectKey: "player", predicateKey: "current_hors", excludeId: id2, supersededBy: id2 });
    const second = engine.markSupersededByKey({ npcId: "goran", subjectKey: "player", predicateKey: "current_hors", excludeId: id2, supersededBy: id2 });
    expect(second).toBe(0);
    void id1;
  });

  it("markSupersededByKey() does not affect other NPCs", () => {
    const otherEngine = new NpcMemoryEngine(db2, "other-npc");
    const idOther = otherEngine.add({ content: "x", tags: [], importance: 70, subjectKey: "player", predicateKey: "current_hors" });
    const id2 = engine.add({ content: "y", tags: [], importance: 70, subjectKey: "player", predicateKey: "current_hors" });
    engine.markSupersededByKey({ npcId: "goran", subjectKey: "player", predicateKey: "current_hors", excludeId: id2, supersededBy: id2 });
    const otherRow = db2.prepare("SELECT superseded_by FROM npc_memories WHERE memory_id=?").get(idOther) as Record<string, unknown>;
    expect(otherRow.superseded_by).toBeNull();
  });

  it("search() filters out superseded rows", () => {
    const id1 = engine.add({ content: "horse is Silvermist", tags: [], importance: 70, subjectKey: "player", predicateKey: "current_hors" });
    const id2 = engine.add({ content: "horse is Shadowfax",  tags: [], importance: 70, subjectKey: "player", predicateKey: "current_hors" });
    engine.markSupersededByKey({ npcId: "goran", subjectKey: "player", predicateKey: "current_hors", excludeId: id2, supersededBy: id2 });
    const hits = engine.search("horse");
    const ids = hits.map(h => h.id);
    expect(ids).toContain(id2);
    expect(ids).not.toContain(id1);
  });

  it("search() returns NULL-key facts unchanged (backward compat)", () => {
    engine.add({ content: "hello world", tags: [], importance: 50 });   // no keys
    const hits = engine.search("hello");
    expect(hits.length).toBe(1);
    expect(hits[0].content).toBe("hello world");
  });
});
