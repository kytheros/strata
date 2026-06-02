// strata/tests/embeddings/vector-search-turns.test.ts
import { describe, it, expect } from "vitest";
import { openDatabase } from "../../src/storage/database.js";
import { VectorSearch } from "../../src/extensions/embeddings/vector-search.js";

function f32Blob(axis: number, dim = 3072): Buffer {
  const v = new Float32Array(dim);
  v[axis] = 1;
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
function unit(axis: number, dim = 3072): Float32Array {
  const v = new Float32Array(dim);
  v[axis] = 1;
  return v;
}

describe("VectorSearch.searchTurnEmbeddings", () => {
  it("ranks turns by cosine and enforces user scoping", () => {
    const db = openDatabase(":memory:");
    const now = Date.now();
    const insTurn = db.prepare(
      `INSERT INTO knowledge_turns (turn_id, session_id, project, user_id, speaker, content, message_index, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insEmb = db.prepare(
      `INSERT INTO knowledge_turn_embeddings (turn_id, embedding, model, created_at, format) VALUES (?, ?, ?, ?, 'float32')`
    );
    // userA: turn on axis 5 (match), turn on axis 9 (no match). userB: axis 5 (must be excluded).
    insTurn.run("ta", "s1", "p", "userA", "assistant", "alpha", 0, now);
    insEmb.run("ta", f32Blob(5), "m", now);
    insTurn.run("tb", "s1", "p", "userA", "assistant", "beta", 1, now);
    insEmb.run("tb", f32Blob(9), "m", now);
    insTurn.run("tc", "s2", "p", "userB", "assistant", "gamma", 0, now);
    insEmb.run("tc", f32Blob(5), "m", now);

    const vs = new VectorSearch(db);
    const hits = vs.searchTurnEmbeddings(unit(5), 10, { userId: "userA" });
    db.close();

    expect(hits.map((h) => h.entryId)).toEqual(["ta"]); // tb cosine 0 filtered; tc excluded by user scope
    expect(hits[0].score).toBeGreaterThan(0.99);
  });
});
