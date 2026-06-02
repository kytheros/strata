// strata/tests/autoresearch/eval-provider-wiring.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

describe("run-eval-hybrid provider wiring", () => {
  it("no longer hardwires GeminiEmbedder and passes modelName to VectorStore", () => {
    const src = readFileSync("autoresearch/search-retrieval/run-eval-hybrid.ts", "utf-8");
    expect(src).not.toMatch(/new GeminiEmbedder\(/);
    expect(src).toMatch(/createEmbeddingProvider\(\)/);
    expect(src).toMatch(/new VectorStore\([^)]*\.modelName/);
  });
});
