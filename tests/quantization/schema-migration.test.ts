import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { openDatabase } from "../../src/storage/database.js";
import type Database from "better-sqlite3";

describe("Quantization schema migration", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `strata-quant-schema-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    db = openDatabase(join(tmpDir, "test.db"));
  });

  afterAll(() => {
    db.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it("embeddings table has format column", () => {
    const col = db.prepare(
      "SELECT 1 FROM pragma_table_info('embeddings') WHERE name = 'format'"
    ).get();
    expect(col).toBeTruthy();
  });

  it("format column defaults to float32", () => {
    db.prepare(
      "INSERT OR REPLACE INTO embeddings (entry_id, embedding, model, created_at) VALUES (?, ?, ?, ?)"
    ).run("test-1", Buffer.alloc(12288), "gemini-embedding-001", Date.now());

    const row = db.prepare("SELECT format FROM embeddings WHERE entry_id = ?").get("test-1") as { format: string };
    expect(row.format).toBe("float32");

    // Cleanup
    db.prepare("DELETE FROM embeddings WHERE entry_id = ?").run("test-1");
  });

  it("migration_state table exists with correct columns", () => {
    const cols = db.prepare("SELECT name FROM pragma_table_info('migration_state')").all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("id");
    expect(names).toContain("current_bit_width");
    expect(names).toContain("target_bit_width");
    expect(names).toContain("total_vectors");
    expect(names).toContain("migrated_vectors");
    expect(names).toContain("status");
    expect(names).toContain("started_at");
    expect(names).toContain("completed_at");
  });
});
