/**
 * Embedding provider interface and factory for vector search.
 *
 * createEmbeddingProvider() dispatches on CONFIG.embeddings.provider (via resolveActiveEmbeddingModel).
 * Gemini is the default provider. local and openai-compatible are not yet wired (throw a clear error);
 * callers already catch → FTS5 fallback, so behavior stays safe.
 */

import { GeminiEmbedder, loadGeminiApiKeyFromConfig, tryCreateGeminiEmbedder } from "../embeddings/gemini-embedder.js";
import { resolveActiveEmbeddingModel } from "../embeddings/active-model.js";
import { OpenAiCompatibleProvider } from "../embeddings/openai-compatible-embedder.js";

/**
 * Interface for embedding providers.
 */
export interface EmbeddingProvider {
  /** Generate embedding for a single text. */
  embed(text: string, taskType?: string): Promise<Float32Array>;
  /** Generate embeddings for multiple texts in batch. */
  embedBatch(texts: string[], taskType?: string): Promise<Float32Array[]>;
  /** Dimensionality of the embedding vectors. */
  readonly dimensions: number;
  /** Model name identifier. */
  readonly modelName: string;
  /** Whether this provider supports TurboQuant quantization (Gemini only). */
  readonly supportsQuantization: boolean;
}

/**
 * Gemini-based embedding provider wrapping GeminiEmbedder.
 */
class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 3072;
  readonly modelName = "gemini-embedding-001";
  readonly supportsQuantization = true;

  constructor(private embedder: GeminiEmbedder) {}

  async embed(text: string, taskType?: string): Promise<Float32Array> {
    return this.embedder.embed(text, taskType);
  }

  async embedBatch(texts: string[], taskType?: string): Promise<Float32Array[]> {
    return this.embedder.embedBatch(texts, taskType);
  }
}

/**
 * Create an embedding provider based on the active provider config.
 *
 * Dispatches on STRATA_EMBEDDING_PROVIDER (via resolveActiveEmbeddingModel).
 * Throws if credentials are missing or the provider is not yet wired.
 * Callers should catch and fall back to FTS5-only search.
 */
export function createEmbeddingProvider(): EmbeddingProvider {
  const active = resolveActiveEmbeddingModel();
  switch (active.provider) {
    case "gemini": {
      const apiKey = loadGeminiApiKeyFromConfig();
      const project = process.env.GOOGLE_CLOUD_PROJECT;
      const region = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
      if (apiKey) return new GeminiEmbeddingProvider(new GeminiEmbedder({ apiKey }));
      if (project) return new GeminiEmbeddingProvider(new GeminiEmbedder({ project, region }));
      throw new Error(
        "No Gemini embedding credentials available. Set GEMINI_API_KEY to enable semantic search."
      );
    }
    case "local":
      throw new Error(
        "local embedding model not available — run `strata embeddings pull` (implemented in Task 13)."
      );
    case "openai-compatible": {
      const baseUrl = process.env.STRATA_EMBEDDING_BASE_URL;
      const apiKey = process.env.STRATA_EMBEDDING_API_KEY;
      if (!baseUrl) {
        throw new Error(
          "openai-compatible provider requires STRATA_EMBEDDING_BASE_URL " +
          "(e.g. http://localhost:1234/v1)."
        );
      }
      return new OpenAiCompatibleProvider({
        baseUrl,
        model: active.model,
        dimensions: active.dimensions,
        apiKey: apiKey || undefined,
      });
    }
    default:
      throw new Error(`Unknown embedding provider: ${active.provider}`);
  }
}

/**
 * Async version that uses tryCreateGeminiEmbedder for full auth cascade probing.
 * Returns null if no credentials are found.
 */
export async function createEmbeddingProviderAsync(): Promise<EmbeddingProvider | null> {
  const embedder = await tryCreateGeminiEmbedder();
  if (!embedder) return null;
  return new GeminiEmbeddingProvider(embedder);
}
