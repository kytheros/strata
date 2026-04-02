import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteEventStore } from "../../src/storage/sqlite-event-store.js";
import type { SVOEvent } from "../../src/storage/interfaces/event-store.js";

function makeEvent(overrides: Partial<SVOEvent> = {}): SVOEvent {
  return {
    subject: "User",
    verb: "attended",
    object: "LGBTQ support group",
    startDate: "2023-05-20",
    endDate: null,
    aliases: ["support meeting", "group session"],
    category: "social",
    sessionId: "session-1",
    project: "test-project",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("SqliteEventStore", () => {
  let db: Database.Database;
  let store: SqliteEventStore;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    store = new SqliteEventStore(db);
    // Seed with a test event
    await store.addEvents([makeEvent()]);
  });

  afterEach(() => {
    db.close();
  });

  it("stores and retrieves events", async () => {
    const events = await store.getBySession("session-1");
    expect(events).toHaveLength(1);
    expect(events[0].subject).toBe("User");
    expect(events[0].verb).toBe("attended");
    expect(events[0].object).toBe("LGBTQ support group");
  });

  it("searches events by keyword", async () => {
    const results = await store.search("support group");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].object).toContain("support group");
  });

  describe("FTS5 special character handling", () => {
    it("does not crash on queries containing question marks", async () => {
      const results = await store.search("What group did they attend?");
      // Should not throw — ? must be sanitized before reaching FTS5
      expect(Array.isArray(results)).toBe(true);
    });

    it("does not crash on queries containing single quotes", async () => {
      const results = await store.search("user's support group");
      expect(Array.isArray(results)).toBe(true);
    });

    it("does not crash on queries with only special characters", async () => {
      const results = await store.search("???");
      expect(results).toEqual([]);
    });

    it("handles Unicode characters in queries", async () => {
      await store.addEvents([makeEvent({
        subject: "Benutzer",
        verb: "besuchte",
        object: "Stra\u00dfe caf\u00e9 m\u00fcnchen",
        sessionId: "session-de",
      })]);
      // Unicode letters like \u00fc (u-umlaut), \u00e9 (e-acute) should be preserved, not stripped
      const results = await store.search("Stra\u00dfe caf\u00e9");
      expect(results.length).toBeGreaterThan(0);
    });
  });
});
