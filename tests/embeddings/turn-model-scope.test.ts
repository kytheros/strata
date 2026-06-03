import { describe, it, expect } from "vitest";
import { openDatabase } from "../../src/storage/database.js";
import { VectorSearch } from "../../src/extensions/embeddings/vector-search.js";

function f32Blob(axis: number, dim = 768): Buffer {
  const v = new Float32Array(dim);
  v[axis] = 1;
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function unit(axis: number, dim = 768): Float32Array {
  const v = new Float32Array(dim);
  v[axis] = 1;
  return v;
}

describe("VectorSearch.searchTurnEmbeddings model scoping", () => {
  it("returns only turns matching the active model", () => {
    const db = openDatabase(":memory:");
    const now = Date.now();

    const insTurn = db.prepare(
      `INSERT INTO knowledge_turns (turn_id, session_id, project, user_id, speaker, content, message_index, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insEmb = db.prepare(
      `INSERT INTO knowledge_turn_embeddings (turn_id, embedding, model, created_at, format) VALUES (?, ?, ?, ?, 'float32')`
    );

    // Insert two turns with different model stamps (same user/project/dimension for simplicity)
    insTurn.run("ta", "s1", "proj", "userA", "user", "text about gemini", 0, now);
    insEmb.run("ta", f32Blob(0), "gemini-embedding-001", now);

    insTurn.run("tb", "s1", "proj", "userA", "user", "text about nomic", 1, now);
    insEmb.run("tb", f32Blob(0), "nomic-embed-text-v1.5", now);

    // VectorSearch scoped to nomic model — should only return tb
    const vs = new VectorSearch(db, "nomic-embed-text-v1.5");
    const hits = vs.searchTurnEmbeddings(unit(0), 10, { userId: "userA" });

    db.close();

    const ids = hits.map(h => h.entryId);
    expect(ids).toContain("tb");
    expect(ids).not.toContain("ta"); // gemini turn must be excluded
  });
});
