// strata/tests/embeddings/dimension-guard.test.ts
import { describe, it, expect } from "vitest";
import { openDatabase } from "../../src/storage/database.js";
import { VectorSearch } from "../../src/extensions/embeddings/vector-search.js";
import { quantize } from "../../src/extensions/quantization/turbo-quant.js";

describe("VectorSearch dimension guard", () => {
  it("skips a stored float32 vector whose length != query length instead of returning a garbage score", async () => {
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
    const hits = await vs.searchAll(q, 10);
    db.close();
    expect(hits).toEqual([]); // mismatched-dim row skipped, not scored
  });

  it("skips a Gemini quantized (tq4) blob on the quantized fast-path when query is 768-dim", async () => {
    // This covers the BLOCKER 2 gap: CONFIG.quantization.enabled=true → quantizedSearch()
    // was called without a dimension guard → ADC scores garbage for a 768-dim query
    // against a 3072-dim stored quantized blob.
    const db = openDatabase(":memory:");
    db.prepare(`INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details)
                VALUES ('e2','fact','p','s',0,'s','d')`).run();
    // Produce a real 3072-dim quantized blob (format tq4).
    const stored = new Float32Array(3072); stored[0] = 1;
    const quantizedBlob = quantize(stored, 4); // Uint8Array, valid tq4 blob
    db.prepare(`INSERT INTO embeddings (entry_id, embedding, model, created_at, format)
                VALUES ('e2', ?, 'gemini-embedding-001', 0, 'tq4')`)
      .run(Buffer.from(quantizedBlob));
    // Query with a 768-dim vector — dimension mismatch must evict the quantized row.
    const q = new Float32Array(768); q[0] = 1;
    const vs = new VectorSearch(db);
    const hits = await vs.searchAll(q, 10);
    db.close();
    expect(hits).toEqual([]); // quantized 3072-dim row evicted, not ADC-scored against 768-dim query
  });
});
