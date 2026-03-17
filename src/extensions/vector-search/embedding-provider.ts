/**
 * Embedding provider interface and Gemini-based implementation for vector search.
 *
 * Gemini is the sole embedding provider. If no Gemini credentials are available,
 * createEmbeddingProvider() throws and callers fall back to FTS5-only search.
 */

import { GeminiEmbedder, tryCreateGeminiEmbedder, loadGeminiApiKeyFromConfig } from "../embeddings/gemini-embedder.js";

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
}

/**
 * Gemini-based embedding provider wrapping GeminiEmbedder.
 */
class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 3072;
  readonly modelName = "gemini-embedding-001";

  constructor(private embedder: GeminiEmbedder) {}

  async embed(text: string, taskType?: string): Promise<Float32Array> {
    return this.embedder.embed(text, taskType);
  }

  async embedBatch(texts: string[], taskType?: string): Promise<Float32Array[]> {
    return this.embedder.embedBatch(texts, taskType);
  }
}

/**
 * Create a Gemini-based embedding provider.
 *
 * Attempts to create a GeminiEmbedder synchronously using GEMINI_API_KEY
 * or GOOGLE_CLOUD_PROJECT env vars. Throws if no credentials are available.
 * Callers should catch and fall back to FTS5-only search.
 */
export function createEmbeddingProvider(): EmbeddingProvider {
  const apiKey = loadGeminiApiKeyFromConfig();
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const region = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";

  if (apiKey) {
    return new GeminiEmbeddingProvider(new GeminiEmbedder({ apiKey }));
  }

  if (project) {
    return new GeminiEmbeddingProvider(new GeminiEmbedder({ project, region }));
  }

  throw new Error(
    "No Gemini embedding credentials available. Set GEMINI_API_KEY or configure in the dashboard to enable semantic search."
  );
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
