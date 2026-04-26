import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../src/transports/world-schema.js";
import { NpcTurnStore } from "../../src/transports/npc-turn-store.js";

let db: Database.Database;
let store: NpcTurnStore;

beforeEach(() => {
  db = new Database(":memory:");
  applySchema(db);
  store = new NpcTurnStore(db);
});
afterEach(() => { db.close(); });

describe("NpcTurnStore", () => {
  it("add() returns a UUID and persists the row", () => {
    const id = store.add({
      npcId: "goran", playerId: "p1", speaker: "player",
      content: "the password is moonstone",
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.count("goran")).toBe(1);
  });

  it("search() finds matching turns by FTS5", () => {
    store.add({ npcId: "goran", playerId: "p1", speaker: "player", content: "the password is moonstone" });
    store.add({ npcId: "goran", playerId: "p1", speaker: "player", content: "nice weather today" });
    const hits = store.search("moonstone", { npcId: "goran", limit: 5 });
    expect(hits.length).toBe(1);
    expect(hits[0].content).toContain("moonstone");
  });

  it("search() scopes results by npc_id", () => {
    store.add({ npcId: "goran", playerId: "p1", speaker: "player", content: "moonstone secret" });
    store.add({ npcId: "brynn", playerId: "p1", speaker: "player", content: "moonstone other" });
    const hits = store.search("moonstone", { npcId: "goran", limit: 5 });
    expect(hits.length).toBe(1);
    expect(hits[0].npcId).toBe("goran");
  });

  it("search() returns BM25 score and rank-ordered results", () => {
    store.add({ npcId: "goran", playerId: "p1", speaker: "player", content: "moonstone moonstone moonstone the secret password" });
    store.add({ npcId: "goran", playerId: "p1", speaker: "player", content: "the password is somewhere in the moonstone vault" });
    const hits = store.search("moonstone password", { npcId: "goran", limit: 5 });
    expect(hits.length).toBe(2);
    expect(typeof hits[0].bm25).toBe("number");
    // Densely repeated 'moonstone' should outrank single occurrence (higher = better post-negation).
    expect(hits[0].bm25).toBeGreaterThanOrEqual(hits[1].bm25);
  });

  it("search() respects limit", () => {
    for (let i = 0; i < 10; i++) {
      store.add({ npcId: "goran", playerId: "p1", speaker: "player", content: `moonstone fact ${i}` });
    }
    const hits = store.search("moonstone", { npcId: "goran", limit: 3 });
    expect(hits.length).toBe(3);
  });

  it("count() returns zero for unknown npcs", () => {
    expect(store.count("nobody")).toBe(0);
  });

  it("add() preserves speaker and player_id", () => {
    const id = store.add({ npcId: "goran", playerId: "alice", speaker: "npc", content: "I am Goran" });
    const row = db.prepare("SELECT speaker, player_id FROM npc_turns WHERE turn_id = ?").get(id) as { speaker: string; player_id: string };
    expect(row.speaker).toBe("npc");
    expect(row.player_id).toBe("alice");
  });
});
