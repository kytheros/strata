/**
 * Model-aware retrieval routing.
 *
 * Detects the consuming model from a model name string and returns
 * tuned retrieval parameters (sessionTopK, useReranker) for that model's
 * context window class.
 *
 * Large-context models (>500K tokens) benefit from high topK and all sessions.
 * Small-context models (<32K tokens) work best with low topK and focused results.
 * One-size-fits-all retrieval hurts both ends.
 *
 * Enabled via CONFIG.modelRouting.enabled (default: false, opt-in).
 */

import { CONFIG } from "../config.js";

export type ModelProfile = "large" | "medium" | "small";

/**
 * Known model patterns and their context size class.
 * Used to auto-detect the consuming model from headers or explicit parameter.
 */
const MODEL_PATTERNS: ReadonlyArray<{ pattern: RegExp; profile: ModelProfile }> = [
  // Large context (>500K)
  { pattern: /gemini.*(flash|pro)/i, profile: "large" },
  { pattern: /claude.*opus/i, profile: "large" },

  // Medium context (32K-500K)
  { pattern: /gpt-4/i, profile: "medium" },
  { pattern: /claude.*(sonnet|haiku)/i, profile: "medium" },
  { pattern: /gemini.*nano/i, profile: "medium" },

  // Small context (<32K)
  { pattern: /gpt-3/i, profile: "small" },
  { pattern: /llama|mistral|phi|qwen/i, profile: "small" },
];

/**
 * Detect the model profile from a model name string.
 * Returns the default profile if no match found.
 */
export function detectModelProfile(modelName?: string): ModelProfile {
  if (!modelName) return CONFIG.modelRouting.defaultProfile as ModelProfile;

  for (const { pattern, profile } of MODEL_PATTERNS) {
    if (pattern.test(modelName)) return profile;
  }

  return CONFIG.modelRouting.defaultProfile as ModelProfile;
}

/**
 * Get retrieval parameters for a given model profile.
 */
export function getRetrievalParams(profile: ModelProfile): {
  sessionTopK: number;
  useReranker: boolean;
} {
  const profiles = CONFIG.modelRouting.profiles;
  return profiles[profile] ?? profiles[CONFIG.modelRouting.defaultProfile as ModelProfile];
}

/**
 * Resolve retrieval parameters from a model name.
 * Returns null if model routing is disabled (caller uses defaults).
 */
export function resolveModelRouting(modelName?: string): {
  sessionTopK: number;
  useReranker: boolean;
} | null {
  if (!CONFIG.modelRouting.enabled) return null;

  const profile = detectModelProfile(modelName);
  return getRetrievalParams(profile);
}
