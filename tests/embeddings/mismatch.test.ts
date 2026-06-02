// strata/tests/embeddings/mismatch.test.ts
import { describe, it, expect } from "vitest";
import { openDatabase } from "../../src/storage/database.js";
import { detectEmbeddingMismatch } from "../../src/extensions/embeddings/mismatch.js";

describe("detectEmbeddingMismatch", () => {
  it("flags mismatch when corpus has vectors but none under the active model", () => {
    const db = openDatabase(":memory:");
    db.prepare(`INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details)
                VALUES ('e1','fact','p','s',0,'s','d')`).run();
    db.prepare(`INSERT INTO embeddings (entry_id, embedding, model, created_at, format)
                VALUES ('e1', ?, 'gemini-embedding-001', 0, 'float32')`).run(Buffer.alloc(12288));
    const r = detectEmbeddingMismatch(db, "nomic-embed-text-v1.5");
    db.close();
    expect(r.mismatch).toBe(true);
    expect(r.activeModelVectors).toBe(0);
    expect(r.otherModelVectors).toBe(1);
  });
});
