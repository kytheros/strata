/**
 * Cross-encoder reranker using MiniLM-L-12-v2 via @huggingface/transformers.
 *
 * Uses the Xenova/ms-marco-MiniLM-L-12-v2 ONNX model (quantized int8, ~34MB).
 * Model is downloaded and cached on first use at ~/.strata/models/.
 *
 * Requires optional dependency: @huggingface/transformers
 */

import { CONFIG } from "../../config.js";
import type { IReranker, RerankRequest, RerankResult } from "./types.js";

const MODEL_ID = "Xenova/ms-marco-MiniLM-L-12-v2";

// Lazy-loaded module references
let tokenizer: any = null;
let model: any = null;
let loadPromise: Promise<boolean> | null = null;

/**
 * Sigmoid function to convert raw logits to 0–1 probability.
 */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

async function loadModel(): Promise<boolean> {
  try {
    const transformers = await import("@huggingface/transformers");

    // Cache models in ~/.strata/models/ (survives npm ci)
    const os = await import("os");
    const path = await import("path");
    const cacheDir = path.join(os.homedir(), ".strata", "models");
    transformers.env.cacheDir = cacheDir;

    tokenizer = await (transformers as any).AutoTokenizer.from_pretrained(MODEL_ID);
    model =
      await (transformers as any).AutoModelForSequenceClassification.from_pretrained(
        MODEL_ID,
        { dtype: "q8" } // quantized int8 — 34MB instead of 134MB
      );

    return true;
  } catch (err) {
    console.error(
      "[strata] Reranker: failed to load model —",
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

/**
 * Ensure model is loaded exactly once (thread-safe via shared promise).
 */
async function ensureModel(): Promise<boolean> {
  if (tokenizer && model) return true;
  if (!loadPromise) {
    loadPromise = loadModel();
  }
  return loadPromise;
}

export class OnnxReranker implements IReranker {
  readonly name = "onnx-minilm";

  async rerank(req: RerankRequest): Promise<RerankResult[] | null> {
    const ready = await ensureModel();
    if (!ready) return null;

    const { query, documents, topN } = req;
    if (documents.length === 0) return [];

    const timeoutMs = CONFIG.reranker.timeoutMs;
    const debug = CONFIG.reranker.debug;
    const start = performance.now();

    try {
      // Tokenize all (query, document) pairs in one batch
      const queries = Array(documents.length).fill(query);
      const texts = documents.map((d) => d.text);

      const inputs = tokenizer(queries, {
        text_pair: texts,
        padding: true,
        truncation: true,
      });

      // Run inference with timeout
      const output = await Promise.race([
        model(inputs),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Reranker timeout")), timeoutMs)
        ),
      ]);

      // Extract raw logits → sigmoid → RerankResult[]
      const logits = Array.from((output as any).logits.data as Float32Array);

      const results: RerankResult[] = documents.map((doc, i) => ({
        id: doc.id,
        relevanceScore: sigmoid(logits[i]),
        originalIndex: i,
      }));

      // Sort by relevance descending
      results.sort((a, b) => b.relevanceScore - a.relevanceScore);

      // Apply topN if specified
      const limited = topN ? results.slice(0, topN) : results;

      if (debug) {
        const elapsed = performance.now() - start;
        const scores = limited.map((r) => r.relevanceScore.toFixed(3));
        console.error(
          `[strata] Reranker: ${documents.length} docs in ${elapsed.toFixed(0)}ms, scores=[${scores.join(", ")}]`
        );
      }

      return limited;
    } catch (err) {
      const elapsed = performance.now() - start;
      console.error(
        `[strata] Reranker: inference failed after ${elapsed.toFixed(0)}ms —`,
        err instanceof Error ? err.message : err
      );
      return null;
    }
  }
}

/**
 * Check whether @huggingface/transformers is available without loading the model.
 */
export async function isOnnxRerankerAvailable(): Promise<boolean> {
  try {
    await import("@huggingface/transformers");
    return true;
  } catch {
    return false;
  }
}
