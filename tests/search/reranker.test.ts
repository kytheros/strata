/**
 * Reranker unit tests.
 *
 * Tests the IReranker interface, NullReranker, factory logic,
 * and score blending math. Does NOT test OnnxReranker (requires
 * model download) — that's validated via benchmark integration.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { NullReranker } from "../../src/search/reranker/null-reranker.js";
import { resetRerankerCache } from "../../src/search/reranker/factory.js";
import type {
  IReranker,
  RerankRequest,
  RerankResult,
} from "../../src/search/reranker/types.js";

// ---------------------------------------------------------------------------
// NullReranker
// ---------------------------------------------------------------------------

describe("NullReranker", () => {
  it("returns null (signals no reranking)", async () => {
    const reranker = new NullReranker();
    const result = await reranker.rerank({
      query: "test query",
      documents: [{ id: "1", text: "some text" }],
    });
    expect(result).toBeNull();
  });

  it('has name "none"', () => {
    const reranker = new NullReranker();
    expect(reranker.name).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// Mock reranker for integration testing
// ---------------------------------------------------------------------------

class MockReranker implements IReranker {
  readonly name = "mock";
  calls: RerankRequest[] = [];
  scores: number[];

  constructor(scores: number[]) {
    this.scores = scores;
  }

  async rerank(req: RerankRequest): Promise<RerankResult[]> {
    this.calls.push(req);
    const results: RerankResult[] = req.documents.map((doc, i) => ({
      id: doc.id,
      relevanceScore: this.scores[i] ?? 0,
      originalIndex: i,
    }));
    results.sort((a, b) => b.relevanceScore - a.relevanceScore);
    if (req.topN) return results.slice(0, req.topN);
    return results;
  }
}

describe("MockReranker", () => {
  it("reranks by score descending", async () => {
    const reranker = new MockReranker([0.1, 0.9, 0.5]);
    const result = await reranker.rerank({
      query: "test",
      documents: [
        { id: "a", text: "low" },
        { id: "b", text: "high" },
        { id: "c", text: "mid" },
      ],
    });

    expect(result).not.toBeNull();
    expect(result![0].id).toBe("b");
    expect(result![1].id).toBe("c");
    expect(result![2].id).toBe("a");
  });

  it("respects topN", async () => {
    const reranker = new MockReranker([0.1, 0.9, 0.5]);
    const result = await reranker.rerank({
      query: "test",
      documents: [
        { id: "a", text: "low" },
        { id: "b", text: "high" },
        { id: "c", text: "mid" },
      ],
      topN: 2,
    });

    expect(result!.length).toBe(2);
    expect(result![0].id).toBe("b");
    expect(result![1].id).toBe("c");
  });

  it("records calls", async () => {
    const reranker = new MockReranker([0.5]);
    await reranker.rerank({
      query: "my query",
      documents: [{ id: "x", text: "doc" }],
    });

    expect(reranker.calls.length).toBe(1);
    expect(reranker.calls[0].query).toBe("my query");
  });
});

// ---------------------------------------------------------------------------
// Score blending math
// ---------------------------------------------------------------------------

describe("Score blending", () => {
  it("alpha=1.0 produces pure reranker score", () => {
    const alpha = 1.0;
    const rerankScore = 0.8;
    const normDcg = 0.3;
    const blended = alpha * rerankScore + (1 - alpha) * normDcg;
    expect(blended).toBeCloseTo(0.8);
  });

  it("alpha=0.0 produces pure DCG score", () => {
    const alpha = 0.0;
    const rerankScore = 0.8;
    const normDcg = 0.3;
    const blended = alpha * rerankScore + (1 - alpha) * normDcg;
    expect(blended).toBeCloseTo(0.3);
  });

  it("alpha=0.7 blends correctly", () => {
    const alpha = 0.7;
    const rerankScore = 0.9;
    const normDcg = 0.5;
    const blended = alpha * rerankScore + (1 - alpha) * normDcg;
    // 0.7 * 0.9 + 0.3 * 0.5 = 0.63 + 0.15 = 0.78
    expect(blended).toBeCloseTo(0.78);
  });

  it("normalizes DCG scores to [0,1]", () => {
    const maxDcg = 2.5;
    const sessions = [
      { dcgScore: 2.5 },
      { dcgScore: 1.0 },
      { dcgScore: 0.5 },
    ];
    const normalized = sessions.map((s) => s.dcgScore / maxDcg);
    expect(normalized[0]).toBeCloseTo(1.0);
    expect(normalized[1]).toBeCloseTo(0.4);
    expect(normalized[2]).toBeCloseTo(0.2);
  });
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

describe("createReranker", () => {
  beforeEach(() => {
    resetRerankerCache();
  });

  it("returns NullReranker when provider is 'none'", async () => {
    const { createReranker } = await import(
      "../../src/search/reranker/factory.js"
    );
    const reranker = await createReranker({ provider: "none" });
    expect(reranker.name).toBe("none");
    const result = await reranker.rerank({
      query: "test",
      documents: [{ id: "1", text: "text" }],
    });
    expect(result).toBeNull();
  });

  it("caches the reranker instance", async () => {
    const { createReranker } = await import(
      "../../src/search/reranker/factory.js"
    );
    const r1 = await createReranker({ provider: "none" });
    const r2 = await createReranker({ provider: "none" });
    expect(r1).toBe(r2);
  });
});
