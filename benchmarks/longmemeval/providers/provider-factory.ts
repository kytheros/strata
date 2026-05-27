/**
 * Provider factory for LongMemEval benchmark.
 *
 * Judge default: GPT-4o (gpt-4o-2024-08-06) — matches the official
 * LongMemEval eval script and all published scores. This ensures
 * Strata's scores are directly comparable to OMEGA, Hindsight, Zep, etc.
 *
 * Answer default: Claude Sonnet 4 → Gemini 2.5 Flash → GPT-4o fallback.
 *
 * Prefix dispatch (spec 2026-05-27-benchmark-multi-model-provider-design §4):
 *   <model>                           → native (OpenAI / Anthropic / Gemini)
 *   ollama:<model>                    → local Ollama
 *   <registered-name>:<model>         → OpenAI-compatible via registry
 *   custom:<model>                    → OpenAI-compatible via env-var override
 */

import type { LlmProvider } from "../../../src/extensions/llm-extraction/llm-provider.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { GeminiProvider } from "../../../src/extensions/llm-extraction/gemini-provider.js";
import { OaiCompatibleProvider } from "./oai-compatible.js";
import { createOllamaBenchProvider } from "./ollama-bench.js";
import { resolveRegistryEntry } from "./provider-registry.js";

/** Known native model names and their providers (back-compat unchanged) */
const NATIVE_MODEL_PROVIDERS: Record<string, "openai" | "anthropic" | "gemini"> = {
  // OpenAI
  "gpt-4o-2024-08-06": "openai",
  "gpt-4o": "openai",
  "gpt-4o-mini": "openai",
  "gpt-4.1": "openai",
  // Anthropic
  "claude-opus-4-6": "anthropic",
  "claude-sonnet-4-6": "anthropic",
  "claude-sonnet-4-20250514": "anthropic",
  "claude-haiku-4-5": "anthropic",
  // Gemini
  "gemini-2.5-flash": "gemini",
  "gemini-2.5-pro": "gemini",
};

/** Options for provider creation */
export interface ProviderOptions {
  /** Extended thinking token budget for Anthropic models (0 = disabled) */
  thinkingBudget?: number;
}

function createNativeProvider(
  model: string,
  purpose: string,
  providerOptions?: ProviderOptions
): { provider: LlmProvider; modelName: string } {
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  const providerType = NATIVE_MODEL_PROVIDERS[model];

  if (providerType === "openai" || model.startsWith("gpt")) {
    if (!openaiKey) {
      throw new Error(`OPENAI_API_KEY required for ${purpose} model: ${model}`);
    }
    return { provider: new OpenAIProvider({ apiKey: openaiKey, model }), modelName: model };
  }

  if (providerType === "anthropic" || model.startsWith("claude")) {
    if (!anthropicKey) {
      throw new Error(`ANTHROPIC_API_KEY required for ${purpose} model: ${model}`);
    }
    const thinkingBudget = providerOptions?.thinkingBudget;
    return {
      provider: new AnthropicProvider({
        apiKey: anthropicKey,
        model,
        ...(thinkingBudget ? { thinkingBudget } : {}),
      }),
      modelName: thinkingBudget ? `${model} (thinking:${thinkingBudget})` : model,
    };
  }

  if (providerType === "gemini" || model.startsWith("gemini")) {
    if (!geminiKey) {
      throw new Error(`GEMINI_API_KEY required for ${purpose} model: ${model}`);
    }
    return { provider: new GeminiProvider({ apiKey: geminiKey, model }), modelName: model };
  }

  throw new Error(`Unknown model for ${purpose}: ${model}`);
}

function createProviderFromIdentifier(
  identifier: string,
  purpose: string,
  providerOptions?: ProviderOptions
): { provider: LlmProvider; modelName: string } {
  // Native model name (exact match in table)
  if (NATIVE_MODEL_PROVIDERS[identifier]) {
    return createNativeProvider(identifier, purpose, providerOptions);
  }

  // ollama:<model>
  if (identifier.startsWith("ollama:")) {
    const model = identifier.slice("ollama:".length);
    return createOllamaBenchProvider(model);
  }

  // custom:<model> — env-var override
  if (identifier.startsWith("custom:")) {
    const baseURL = process.env.LONGMEMEVAL_OAI_COMPAT_BASE_URL;
    const apiKey = process.env.LONGMEMEVAL_OAI_COMPAT_API_KEY;
    if (!baseURL) {
      throw new Error(
        `LONGMEMEVAL_OAI_COMPAT_BASE_URL required for custom: ${purpose} model: ${identifier}`
      );
    }
    if (!apiKey) {
      throw new Error(
        `LONGMEMEVAL_OAI_COMPAT_API_KEY required for custom: ${purpose} model: ${identifier}`
      );
    }
    const model = identifier.slice("custom:".length);
    return {
      provider: new OaiCompatibleProvider({
        providerName: "custom",
        baseURL,
        apiKey,
        model,
      }),
      modelName: identifier,
    };
  }

  // <registered-name>:<model> — registry lookup
  const colonIdx = identifier.indexOf(":");
  if (colonIdx > 0) {
    const providerName = identifier.slice(0, colonIdx);
    const model = identifier.slice(colonIdx + 1);
    const entry = resolveRegistryEntry(providerName);
    if (entry) {
      const apiKey = process.env[entry.apiKeyEnvVar];
      if (!apiKey) {
        throw new Error(
          `${entry.apiKeyEnvVar} required for ${providerName}: ${purpose} model: ${model}`
        );
      }
      return {
        provider: new OaiCompatibleProvider({
          providerName,
          baseURL: entry.baseURL,
          apiKey,
          model,
          headers: entry.headers,
        }),
        modelName: identifier,
      };
    }
  }

  // Fall back to native — handles bare prefixes like "gpt-" / "claude-" / "gemini-"
  // that startsWith() catches inside createNativeProvider
  return createNativeProvider(identifier, purpose, providerOptions);
}

/**
 * Create the provider for answer generation.
 *
 * Default priority: Anthropic → Gemini → OpenAI
 * (Use the best available model for generating answers)
 */
export function createAnswerProvider(options?: ProviderOptions): {
  provider: LlmProvider;
  modelName: string;
} {
  const override = process.env.LONGMEMEVAL_ANSWER_MODEL;
  if (override) {
    return createProviderFromIdentifier(override, "answer generation", options);
  }

  // Auto-detect: prefer Anthropic for answer quality
  if (process.env.ANTHROPIC_API_KEY) {
    return createNativeProvider("claude-sonnet-4-6", "answer generation", options);
  }
  if (process.env.GEMINI_API_KEY) {
    return createNativeProvider("gemini-2.5-flash", "answer generation", options);
  }
  if (process.env.OPENAI_API_KEY) {
    return createNativeProvider("gpt-4o", "answer generation", options);
  }

  throw new Error(
    "No API key found for answer generation. Set ANTHROPIC_API_KEY, GEMINI_API_KEY, or OPENAI_API_KEY, " +
      "or set LONGMEMEVAL_ANSWER_MODEL=ollama:<model> for local inference."
  );
}

/**
 * Create the provider for judge scoring.
 *
 * Default: GPT-4o (gpt-4o-2024-08-06) — the official LongMemEval judge.
 * This is critical for score comparability with published benchmarks.
 * Falls back to Anthropic → Gemini if no OpenAI key is available.
 */
export function createJudgeProvider(): {
  provider: LlmProvider;
  modelName: string;
} {
  const override = process.env.LONGMEMEVAL_JUDGE_MODEL;
  if (override) {
    return createProviderFromIdentifier(override, "judge scoring");
  }

  // Default: GPT-4o for comparability with published scores
  if (process.env.OPENAI_API_KEY) {
    return createNativeProvider("gpt-4o-2024-08-06", "judge scoring");
  }

  // Fallback with warning
  if (process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "⚠ No OPENAI_API_KEY — using Claude as judge. Scores may not be directly comparable to published LongMemEval results (which use GPT-4o)."
    );
    return createNativeProvider("claude-sonnet-4-6", "judge scoring");
  }
  if (process.env.GEMINI_API_KEY) {
    console.warn(
      "⚠ No OPENAI_API_KEY — using Gemini as judge. Scores may not be directly comparable to published LongMemEval results (which use GPT-4o)."
    );
    return createNativeProvider("gemini-2.5-flash", "judge scoring");
  }

  throw new Error(
    "No API key found for judge scoring. Set OPENAI_API_KEY (recommended for comparable scores), ANTHROPIC_API_KEY, or GEMINI_API_KEY."
  );
}
