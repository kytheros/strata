import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../src/transports/world-schema.js";
import { CharacterStore } from "../../src/transports/character-store.js";

let db: Database.Database;
let store: CharacterStore;

beforeEach(() => {
  db = new Database(":memory:");
  applySchema(db);
  store = new CharacterStore(db);
});

afterEach(() => {
  db.close();
});

describe("CharacterStore (SQL)", () => {
  it("write + read round-trips a character card", () => {
    store.write("player1", {
      displayName: "Mike",
      factions: ["millhaven-merchants"],
      tags: ["human", "warrior"],
    });
    const card = store.read("player1");
    expect(card.displayName).toBe("Mike");
    expect(card.factions).toEqual(["millhaven-merchants"]);
    expect(card.tags).toEqual(["human", "warrior"]);
  });

  it("returns empty defaults for unknown player", () => {
    const card = store.read("unknown");
    expect(card.displayName).toBe("");
    expect(card.factions).toEqual([]);
    expect(card.tags).toEqual([]);
  });

  it("handles missing optional fields gracefully", () => {
    store.write("sparse", {});
    const card = store.read("sparse");
    expect(card.displayName).toBe("");
    expect(card.factions).toEqual([]);
  });

  it("write on existing player updates the record", () => {
    store.write("player1", { displayName: "Old", factions: [], tags: [] });
    store.write("player1", { displayName: "New", factions: ["guild"], tags: ["elf"] });
    const card = store.read("player1");
    expect(card.displayName).toBe("New");
    expect(card.factions).toEqual(["guild"]);
    expect(card.tags).toEqual(["elf"]);
  });

  it("two players are stored independently", () => {
    store.write("p1", { displayName: "Alice", factions: ["merchants"], tags: [] });
    store.write("p2", { displayName: "Bob", factions: ["thieves"], tags: ["rogue"] });
    expect(store.read("p1").displayName).toBe("Alice");
    expect(store.read("p2").displayName).toBe("Bob");
    expect(store.read("p1").factions).toEqual(["merchants"]);
    expect(store.read("p2").factions).toEqual(["thieves"]);
  });
});
