// strata/tests/embeddings/read-model-scope.test.ts
import { describe, it, expect } from "vitest";
import { openDatabase } from "../../src/storage/database.js";
import { VectorSearch } from "../../src/extensions/embeddings/vector-search.js";

describe("VectorSearch model scoping", () => {
  it("returns only active-model vectors", () => {
    const db = openDatabase(":memory:");
    db.prepare(`INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details)
                VALUES ('e1','fact','p','s',0,'s','d')`).run();
    const v = new Float32Array(768); v[0] = 1;
    const blob = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    const ins = db.prepare(`INSERT INTO embeddings (entry_id, embedding, model, created_at, format)
                            VALUES (?, ?, ?, 0, 'float32')`);
    ins.run("e1", blob, "nomic-embed-text-v1.5");
    db.prepare(`INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details)
                VALUES ('e2','fact','p','s',0,'s','d')`).run();
    ins.run("e2", blob, "gemini-embedding-001");
    const vs = new VectorSearch(db, "nomic-embed-text-v1.5");
    const hits = vs.searchAll(new Float32Array(v), 10);
    db.close();
    expect(hits.map((h) => h.entryId)).toEqual(["e1"]); // e2 (gemini) excluded
  });
});
