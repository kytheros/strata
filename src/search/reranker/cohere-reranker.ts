/**
 * Cohere Rerank v3.5 cross-encoder reranker.
 *
 * Uses the Cohere Rerank API (v2) with the rerank-v3.5 model.
 * Requires COHERE_API_KEY environment variable.
 *
 * Uses native fetch — no third-party HTTP libraries (per supply chain policy).
 */

import type { IReranker, RerankRequest, RerankResult } from "./types.js";

const COHERE_RERANK_URL = "https://api.cohere.com/v2/rerank";
const DEFAULT_MODEL = "rerank-v3.5";

export class CohereReranker implements IReranker {
  readonly name = "cohere-rerank-v3.5";
  private apiKey: string;
  private model: string;

  constructor(options?: { apiKey?: string; model?: string }) {
    this.apiKey = options?.apiKey || process.env.COHERE_API_KEY || "";
    this.model = options?.model || DEFAULT_MODEL;
    if (!this.apiKey) {
      throw new Error("COHERE_API_KEY required for Cohere reranker");
    }
  }

  async rerank(req: RerankRequest): Promise<RerankResult[] | null> {
    if (req.documents.length === 0) return [];

    const topN = req.topN ?? req.documents.length;

    const body = {
      model: this.model,
      query: req.query,
      documents: req.documents.map((d) => d.text),
      top_n: topN,
    };

    const response = await fetch(COHERE_RERANK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[cohere-reranker] API error ${response.status}: ${text}`);
      return null;
    }

    const data = (await response.json()) as {
      results: Array<{
        index: number;
        relevance_score: number;
      }>;
    };

    return data.results.map((r) => ({
      id: req.documents[r.index].id,
      relevanceScore: r.relevance_score,
      originalIndex: r.index,
    }));
  }
}

/** Check if Cohere reranker is available (API key set). */
export function isCohereRerankerAvailable(): boolean {
  return !!process.env.COHERE_API_KEY;
}
