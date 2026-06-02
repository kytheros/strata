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
 * Read the `embeddings` block from ~/.strata/config.json.
 * Returns an empty object if the file is absent, unreadable, or malformed — never throws.
 * Reads homedir() at call time so tests can override HOME/USERPROFILE.
 */
export function loadEmbeddingsConfigFromFile(): Partial<{
  provider: string;
  model: string;
  dimensions: number;
}> {
  try {
    const configPath = join(homedir(), ".strata", "config.json");
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
