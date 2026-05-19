/**
 * SqliteKnowledgeTurnStore — createdAt override tests.
 * Spec: 2026-05-18-temporal-retrieval-intervention (Task 2).
 */

import { describe, it, expect } from "vitest";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteKnowledgeTurnStore } from "../../src/storage/sqlite-knowledge-turn-store.js";

describe("SqliteKnowledgeTurnStore — createdAt override", () => {
  it("honors a caller-provided createdAt instead of Date.now()", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteKnowledgeTurnStore(db);

    const fixedTimestamp = 1700604800000; // 2023-11-22T00:00:00Z
    await store.insert({
      sessionId: "s1",
      project: "test",
      userId: null,
      speaker: "user",
      content: "hello",
      messageIndex: 0,
      createdAt: fixedTimestamp,
    });

    const rows = await store.getBySessionId("s1");
    expect(rows).toHaveLength(1);
    expect(rows[0].createdAt).toBe(fixedTimestamp);
  });

  it("falls back to Date.now() when createdAt is omitted", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteKnowledgeTurnStore(db);
    const before = Date.now();
    await store.insert({
      sessionId: "s1",
      project: "test",
      userId: null,
      speaker: "user",
      content: "hello",
      messageIndex: 0,
    });
    const after = Date.now();

    const rows = await store.getBySessionId("s1");
    expect(rows[0].createdAt).toBeGreaterThanOrEqual(before);
    expect(rows[0].createdAt).toBeLessThanOrEqual(after);
  });
});
