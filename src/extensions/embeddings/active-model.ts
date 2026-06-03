/**
 * Single source of truth for the active embedding model (provider, model name, dimensions).
 *
 * Feeds write-stamping, read-scoping, and the startup mismatch check so they
 * never diverge. Priority: env var > ~/.strata/config.json > provider default.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

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
 * Read the `embeddings` block from the active config.json.
 * Resolves the same path as `getConfigPath()` in cli/embeddings.ts + cli/distill.ts:
 *   STRATA_DATA_DIR/config.json  (when STRATA_DATA_DIR is set)
 *   homedir()/.strata/config.json  (default)
 * Returns an empty object if the file is absent, unreadable, or malformed — never throws.
 * Reads process.env and homedir() at call time so tests can override either.
 */
export function loadEmbeddingsConfigFromFile(): Partial<{
  provider: string;
  model: string;
  dimensions: number;
}> {
  try {
    const configPath = join(
      process.env.STRATA_DATA_DIR || join(homedir(), ".strata"),
      "config.json"
    );
    if (!existsSync(configPath)) return {};
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    if (raw && typeof raw === "object" && raw.embeddings && typeof raw.embeddings === "object") {
      return raw.embeddings as Partial<{ provider: string; model: string; dimensions: number }>;
    }
  } catch {
    // File missing, unreadable, or malformed — return empty
  }
  return {};
}

/**
 * Single source of truth for the active embedding (provider, model, dimensions).
 * Feeds write-stamping, read-scoping, and the startup mismatch check so they never diverge.
 *
 * Priority (each field resolved independently):
 *   env var > ~/.strata/config.json embeddings.* > provider default
 *
 * Reads process.env and homedir() at call time (not cached) so tests can manipulate them.
 */
export function resolveActiveEmbeddingModel(): ActiveEmbeddingModel {
  const file = loadEmbeddingsConfigFromFile();

  // Provider: env > file > default
  const provider = (
    (process.env.STRATA_EMBEDDING_PROVIDER as "gemini" | "local" | "openai-compatible" | undefined) ||
    (file.provider as "gemini" | "local" | "openai-compatible" | undefined) ||
    "gemini"
  );

  const d = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.gemini;

  // Model: env > file > provider-aware default
  // Cleanup A: a Gemini model name must not be stamped as a non-Gemini provider's model.
  const rawEnvModel = process.env.STRATA_EMBEDDING_MODEL;
  const rawFileModel = typeof file.model === "string" ? file.model : undefined;
  const rawModel = rawEnvModel || rawFileModel;

  let model: string;
  if (!rawModel) {
    // No override at all — use provider default
    model = d.model;
  } else if (provider === "gemini") {
    // Gemini: honour any explicit model name (incl. gemini-embedding-002, etc.)
    model = rawModel;
  } else {
    // Non-Gemini: if the override is a Gemini model name, ignore it and fall back to
    // the provider default. This guards against accidentally stamping a Gemini name
    // onto a local/openai-compatible embedding.
    const isGeminiModel = rawModel.startsWith("gemini-") || rawModel.startsWith("text-embedding-0");
    model = isGeminiModel ? d.model : rawModel;
  }

  // Dimensions: env > file > provider default
  const envDim = process.env.STRATA_EMBEDDING_DIMENSIONS;
  const fileDim = typeof file.dimensions === "number" ? file.dimensions : undefined;
  const dimensions = envDim ? Number(envDim) : (fileDim ?? d.dimensions);

  return { provider, model, dimensions };
}

/**
 * Decide whether to attempt document chunk embeddings given the active provider
 * and the availability of Gemini credentials.
 *
 * Document embeddings ALWAYS require a Gemini key because they use the multimodal
 * Gemini Embedding 2 model (not the active text provider). When a non-Gemini text
 * provider is active and no Gemini key is available, documents are stored and
 * FTS5-indexed but NOT vector-embedded.
 *
 * @param active - The resolved active embedding model (from resolveActiveEmbeddingModel).
 * @param hasGeminiCreds - Whether a Gemini API key (or GCP project) is configured.
 * @returns true when document vectors should be generated; false → FTS5-only.
 *
 * @internal This is a pure predicate available for tests and future callers.
 * The actual document-ingest gate in `store-document.ts` uses `!embedder` directly
 * (the embedder is constructed from `geminiKey` in `server.ts`, which is the same
 * condition). Keep both consistent if either is changed.
 */
export function shouldEmbedDocuments(
  _active: ActiveEmbeddingModel,
  hasGeminiCreds: boolean
): boolean {
  // Documents need Gemini regardless of the active text provider.
  return hasGeminiCreds;
}
