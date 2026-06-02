// strata/tests/storage/embeddings-coexistence.test.ts
import { describe, it, expect } from "vitest";
import { openDatabase } from "../../src/storage/database.js";

describe("embeddings (entry_id, model) coexistence", () => {
  it("stores two models' vectors for the same entry without replacement", () => {
    const db = openDatabase(":memory:");
    db.prepare(`INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details)
                VALUES ('e1','fact','p','s',0,'s','d')`).run();
    const ins = db.prepare(`INSERT INTO embeddings (entry_id, embedding, model, created_at, format)
                            VALUES (?, ?, ?, ?, 'float32')`);
    ins.run("e1", Buffer.alloc(12288), "gemini-embedding-001", 0);
    ins.run("e1", Buffer.alloc(3072), "nomic-embed-text-v1.5", 0);
    const rows = db.prepare("SELECT model FROM embeddings WHERE entry_id='e1' ORDER BY model").all();
    db.close();
    expect(rows.map((r: any) => r.model)).toEqual(["gemini-embedding-001", "nomic-embed-text-v1.5"]);
  });
});
