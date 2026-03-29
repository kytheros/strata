/**
 * Reranker factory with auto-detection.
 *
 * Priority:
 * 1. Explicit provider override
 * 2. ONNX runtime available → OnnxReranker
 * 3. Nothing available → NullReranker
 *
 * Module-level cache ensures only one reranker instance exists.
 */

import { NullReranker } from "./null-reranker.js";
import type { IReranker } from "./types.js";

export interface RerankerOptions {
  /** Override provider selection. */
  provider?: "onnx" | "none";
}

let cachedReranker: IReranker | undefined;

/**
 * Create or return a cached reranker instance.
 */
export async function createReranker(
  options?: RerankerOptions
): Promise<IReranker> {
  if (cachedReranker) return cachedReranker;

  const provider = options?.provider;

  // Explicit "none" → passthrough
  if (provider === "none") {
    cachedReranker = new NullReranker();
    return cachedReranker;
  }

  // Explicit "onnx" or auto-detect
  if (provider === "onnx" || !provider) {
    try {
      const { isOnnxRerankerAvailable, OnnxReranker } = await import(
        "./onnx-reranker.js"
      );
      if (await isOnnxRerankerAvailable()) {
        cachedReranker = new OnnxReranker();
        console.error("[strata] Reranker: onnx-minilm (auto-detected)");
        return cachedReranker;
      }
    } catch {
      // @huggingface/transformers not installed
    }

    // If explicitly requested onnx but it's not available, warn
    if (provider === "onnx") {
      console.error(
        "[strata] Reranker: onnx requested but @huggingface/transformers not installed — falling back to none"
      );
    }
  }

  // Fallback: no reranking
  cachedReranker = new NullReranker();
  console.error("[strata] Reranker: none");
  return cachedReranker;
}

/**
 * Reset the cached reranker (for testing).
 */
export function resetRerankerCache(): void {
  cachedReranker = undefined;
}
