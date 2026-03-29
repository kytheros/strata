import type { IReranker, RerankResult } from "./types.js";

/**
 * Passthrough reranker — returns null to signal "use original order".
 * Used when no reranker is configured or available.
 */
export class NullReranker implements IReranker {
  readonly name = "none";

  async rerank(): Promise<RerankResult[] | null> {
    return null;
  }
}
