import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CharacterStore } from "../../src/transports/character-store.js";

let baseDir: string;
let store: CharacterStore;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "strata-character-test-"));
  store = new CharacterStore(baseDir);
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe("CharacterStore", () => {
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
});
