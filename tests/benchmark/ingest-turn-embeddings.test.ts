// strata/tests/benchmark/ingest-turn-embeddings.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ingestSrc = readFileSync(join(__dirname, "../../benchmarks/longmemeval/ingest.ts"), "utf8");

describe("benchmark ingest dense turn-lane wiring", () => {
  it("constructs the turn store WITH the embedder", () => {
    expect(ingestSrc).toMatch(/new SqliteKnowledgeTurnStore\(\s*db\s*,\s*embedder\s*\)/);
  });
  it("populates turns via bulkInsert (one embedBatch per session)", () => {
    expect(ingestSrc).toMatch(/turnStore\.bulkInsert\(/);
  });
});
