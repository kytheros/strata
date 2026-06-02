/**
 * Single source of truth for the active embedding model (provider, model name, dimensions).
 *
 * Feeds write-stamping, read-scoping, and the startup mismatch check so they
 * never diverge. Reads process.env directly so tests can override env vars.
 */

export interface ActiveEmbeddingModel {
  provider: "gemini" | "local" | "openai-compatible";
  model: string;
  dimensions: number;
}

const PROVIDER_DEFAULTS: Record<string, { model: string; dimensions: number }> = {
  gemini: { model: "gemini-embedding-001", dimensions: 3072 },
  local: { model: "nomic-embed-text-v1.5", dimensions: 768 },
  "openai-compatible": { model: "text-embedding-3-small", dimensions: 1536 },
};

/**
 * Single source of truth for the active embedding (provider, model, dimensions).
 * Feeds write-stamping, read-scoping, and the startup mismatch check so they never diverge.
 * Reads process.env at call time (not cached) so tests can manipulate env vars.
 */
export function resolveActiveEmbeddingModel(): ActiveEmbeddingModel {
  const provider = (process.env.STRATA_EMBEDDING_PROVIDER as "gemini" | "local" | "openai-compatible") || "gemini";
  const d = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.gemini;
  const envModel = process.env.STRATA_EMBEDDING_MODEL;
  const model = envModel && envModel !== "gemini-embedding-001"
    ? envModel
    : (provider === "gemini" ? "gemini-embedding-001" : d.model);
  const envDim = process.env.STRATA_EMBEDDING_DIMENSIONS;
  const dimensions = envDim ? Number(envDim) : d.dimensions;
  return { provider, model, dimensions };
}
