/**
 * OpenAI-compatible provider registry for the LongMemEval benchmark.
 *
 * Maps a short provider name (used in LONGMEMEVAL_ANSWER_MODEL prefixes
 * like `openrouter:meta-llama/llama-3.3-70b`) to the baseURL + API-key env
 * var combination. New providers can be added without code changes elsewhere.
 *
 * Spec: specs/2026-05-27-benchmark-multi-model-provider-design.md §4
 */

export interface RegistryEntry {
  baseURL: string;
  apiKeyEnvVar: string;
  /** Optional extra headers (e.g., OpenRouter referer / app-title hints) */
  headers?: Record<string, string>;
}

export const PROVIDER_REGISTRY: Record<string, RegistryEntry> = {
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnvVar: "OPENROUTER_API_KEY",
  },
  together: {
    baseURL: "https://api.together.xyz/v1",
    apiKeyEnvVar: "TOGETHER_API_KEY",
  },
  fireworks: {
    baseURL: "https://api.fireworks.ai/inference/v1",
    apiKeyEnvVar: "FIREWORKS_API_KEY",
  },
  groq: {
    baseURL: "https://api.groq.com/openai/v1",
    apiKeyEnvVar: "GROQ_API_KEY",
  },
  deepinfra: {
    baseURL: "https://api.deepinfra.com/v1/openai",
    apiKeyEnvVar: "DEEPINFRA_API_KEY",
  },
  mistral: {
    baseURL: "https://api.mistral.ai/v1",
    apiKeyEnvVar: "MISTRAL_API_KEY",
  },
  xai: {
    baseURL: "https://api.x.ai/v1",
    apiKeyEnvVar: "XAI_API_KEY",
  },
  "local-vllm": {
    baseURL: "http://localhost:8000/v1",
    apiKeyEnvVar: "LOCAL_VLLM_API_KEY",
  },
};

export function resolveRegistryEntry(name: string): RegistryEntry | null {
  return PROVIDER_REGISTRY[name] ?? null;
}
