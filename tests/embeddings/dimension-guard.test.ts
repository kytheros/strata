// strata/tests/embeddings/dimension-guard.test.ts
import { describe, it, expect } from "vitest";
import { openDatabase } from "../../src/storage/database.js";
import { VectorSearch } from "../../src/extensions/embeddings/vector-search.js";

describe("VectorSearch dimension guard", () => {
  it("skips a stored vector whose length != query length instead of returning a garbage score", () => {
    const db = openDatabase(":memory:");
    db.prepare(`INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details)
                VALUES ('e1','fact','p','s',0,'s','d')`).run();
    // Stored 3072-dim Gemini blob; query will be 768-dim.
    const stored = new Float32Array(3072); stored[0] = 1;
    db.prepare(`INSERT INTO embeddings (entry_id, embedding, model, created_at, format)
                VALUES ('e1', ?, 'gemini-embedding-001', 0, 'float32')`)
      .run(Buffer.from(stored.buffer, stored.byteOffset, stored.byteLength));
    const q = new Float32Array(768); q[0] = 1;
    const vs = new VectorSearch(db);
    const hits = vs.searchAll(q, 10);
    db.close();
    expect(hits).toEqual([]); // mismatched-dim row skipped, not scored
  });
});
