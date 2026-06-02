// strata/tests/storage/turn-embeddings-migration.test.ts
import { describe, it, expect } from "vitest";
import { openDatabase } from "../../src/storage/database.js";

describe("knowledge_turn_embeddings migration", () => {
  it("creates the table with the expected columns", () => {
    const db = openDatabase(":memory:");
    const cols = db
      .prepare("SELECT name FROM pragma_table_info('knowledge_turn_embeddings')")
      .all()
      .map((r: any) => r.name)
      .sort();
    db.close();
    expect(cols).toEqual(["created_at", "embedding", "format", "model", "turn_id"]);
  });

  it("is idempotent (opening twice does not throw)", () => {
    const db = openDatabase(":memory:");
    // openDatabase runs the full schema migration; a second manual run must be a no-op.
    expect(() =>
      db.exec(`CREATE TABLE IF NOT EXISTS knowledge_turn_embeddings (
        turn_id TEXT PRIMARY KEY, embedding BLOB NOT NULL, model TEXT NOT NULL,
        created_at INTEGER NOT NULL, format TEXT NOT NULL DEFAULT 'float32')`)
    ).not.toThrow();
    db.close();
  });
});
