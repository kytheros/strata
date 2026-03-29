/**
 * Cross-encoder reranker interface.
 *
 * Pluggable reranking for the search pipeline. Implementations:
 * - NullReranker: passthrough (no reranking)
 * - OnnxReranker: local MiniLM-L-12-v2 via ONNX Runtime
 * - WorkersAIReranker: Cloudflare Workers AI (future)
 * - ApiReranker: Voyage/Jina HTTP API (future)
 */

export interface RerankDocument {
  /** Opaque identifier passed through to results. */
  id: string;
  /** Text to score against the query. */
  text: string;
}

export interface RerankRequest {
  query: string;
  documents: RerankDocument[];
  topN?: number;
}

export interface RerankResult {
  id: string;
  /** Relevance score from the cross-encoder (0–1 normalized). */
  relevanceScore: number;
  /** Original index in the input array. */
  originalIndex: number;
}

export interface IReranker {
  /**
   * Rerank documents by relevance to the query.
   * Returns results sorted by relevanceScore descending.
   * Returns null to signal "no reranking available" — caller uses original order.
   */
  rerank(req: RerankRequest): Promise<RerankResult[] | null>;

  /** Human-readable name for logging. */
  readonly name: string;
}
