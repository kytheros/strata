import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { MigrationWorker } from "../../src/extensions/quantization/migration.js";

describe("MigrationWorker", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `strata-migration-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    db = openDatabase(join(tmpDir, "test.db"));
  });

  afterAll(() => {
    db.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it("migrates float32 vectors to quantized format", async () => {
    // Insert 5 Float32 embeddings using pseudo-random vectors (LCG).
    // Real embeddings from neural nets have near-uniform energy spread,
    // similar to random vectors. Smooth sinusoids concentrate energy
    // in few Hadamard bins and don't represent real-world embeddings.
    const insert = db.prepare(
      "INSERT OR REPLACE INTO embeddings (entry_id, embedding, model, created_at, format) VALUES (?, ?, ?, ?, ?)"
    );
    for (let i = 0; i < 5; i++) {
      const vec = new Float32Array(3072);
      let seed = 42 + i * 1000;
      for (let j = 0; j < 3072; j++) {
        seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
        vec[j] = seed / 0x7fffffff - 0.5;
      }
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      for (let j = 0; j < 3072; j++) vec[j] /= norm;
      const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
      insert.run(`entry-${i}`, buf, "gemini-embedding-001", Date.now(), "float32");
    }

    const worker = new MigrationWorker(db, 4);
    const result = await worker.run();

    expect(result.migrated).toBe(5);
    expect(result.failed).toBe(0);

    // Verify all are now quantized
    const rows = db.prepare("SELECT format FROM embeddings").all() as { format: string }[];
    for (const row of rows) {
      expect(row.format).toBe("tq4");
    }

    // Verify migration_state is updated
    const state = db.prepare("SELECT * FROM migration_state WHERE id = 'quantization'").get() as Record<string, unknown>;
    expect(state.status).toBe("complete");
    expect(state.migrated_vectors).toBe(5);
  });

  it("skips already-quantized vectors", async () => {
    // All vectors from previous test are already tq4
    const worker = new MigrationWorker(db, 4);
    const result = await worker.run();

    expect(result.migrated).toBe(0);
    expect(result.skipped).toBe(5);
  });
});
