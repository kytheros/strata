/**
 * Test: reindexTurns backfill function.
 *
 * Seeds knowledge_turns rows without embeddings, then calls reindexTurns
 * and verifies that knowledge_turn_embeddings rows are created with the
 * correct model stamp.
 *
 * Spec: 2026-06-03-dense-turn-lane-production-design §3.8.
 */
import { describe, it, expect } from "vitest";
import { openDatabase } from "../../src/storage/database.js";
import { reindexTurns } from "../../src/extensions/embeddings/reindex-turns.js";
import type { EmbeddingProvider } from "../../src/extensions/vector-search/embedding-provider.js";

function fakeProvider(): EmbeddingProvider {
  const v = (dim: number) => { const a = new Float32Array(dim); a[0] = 1; return a; };
  return {
    dimensions: 768,
    modelName: "nomic-embed-text-v1.5",
    supportsQuantization: false,
    embed: async () => v(768),
    embedBatch: async (t: string[]) => t.map(() => v(768)),
  } as unknown as EmbeddingProvider;
}

describe("reindexTurns", () => {
  it("embeds all non-empty turns that lack a vector under the active model", async () => {
    const db = openDatabase(":memory:");

    // Seed two turns without embeddings
    const insTurn = db.prepare(
      `INSERT INTO knowledge_turns (turn_id, session_id, project, user_id, speaker, content, message_index, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const now = Date.now();
    insTurn.run("turn-a", "s1", "proj", null, "user", "what is the answer", 0, now);
    insTurn.run("turn-b", "s1", "proj", null, "assistant", "the answer is 42", 1, now);

    const provider = fakeProvider();
    const result = await reindexTurns(db, provider);

    const rows = db.prepare("SELECT model FROM knowledge_turn_embeddings").all() as { model: string }[];
    db.close();

    expect(result.embedded).toBe(2);
    expect(result.failed).toBe(0);
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.model).toBe("nomic-embed-text-v1.5");
    }
  });

  it("skips turns that already have a vector under the active model (resumable)", async () => {
    const db = openDatabase(":memory:");
    const provider = fakeProvider();

    // Seed a turn AND its embedding
    const insTurn = db.prepare(
      `INSERT INTO knowledge_turns (turn_id, session_id, project, user_id, speaker, content, message_index, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insEmb = db.prepare(
      `INSERT INTO knowledge_turn_embeddings (turn_id, embedding, model, created_at, format) VALUES (?, ?, ?, ?, ?)`
    );
    const now = Date.now();
    const buf = Buffer.from(new Float32Array(768).buffer);
    insTurn.run("turn-x", "s1", "proj", null, "user", "already embedded content", 0, now);
    insEmb.run("turn-x", buf, "nomic-embed-text-v1.5", now, "float32");

    const result = await reindexTurns(db, provider);
    db.close();

    // Nothing to embed — the turn already has a vector
    expect(result.embedded).toBe(0);
  });

  it("skips empty/whitespace-only turn content", async () => {
    const db = openDatabase(":memory:");
    const provider = fakeProvider();

    const insTurn = db.prepare(
      `INSERT INTO knowledge_turns (turn_id, session_id, project, user_id, speaker, content, message_index, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const now = Date.now();
    insTurn.run("turn-empty", "s1", "proj", null, "user", "   ", 0, now);
    insTurn.run("turn-real", "s1", "proj", null, "assistant", "real content here", 1, now);

    const result = await reindexTurns(db, provider);
    db.close();

    expect(result.embedded).toBe(1); // only the non-empty turn
  });
});
