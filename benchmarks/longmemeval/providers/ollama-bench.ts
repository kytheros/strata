/**
 * Thin factory wrapper around the production OllamaProvider for the
 * LongMemEval benchmark.
 *
 * The production OllamaProvider lives in
 * src/extensions/llm-extraction/llm-provider.ts and is the same one used
 * by the distillation pipeline (extraction / conflict resolution /
 * summarization). The benchmark reuses it directly — no duplicate
 * implementation, no parallel maintenance.
 *
 * Spec: specs/2026-05-27-benchmark-multi-model-provider-design.md §7
 */

import type { LlmProvider } from "../../../src/extensions/llm-extraction/llm-provider.js";
import { OllamaProvider } from "../../../src/extensions/llm-extraction/llm-provider.js";

/**
 * Create an Ollama-backed LlmProvider for the benchmark.
 *
 * @param model - Ollama model identifier (e.g., "qwen2.5:14b", "gemma4:e4b").
 *                Pass-through unchanged; Ollama accepts model:tag shape.
 * @returns provider + modelName for logging.
 */
export function createOllamaBenchProvider(model: string): {
  provider: LlmProvider;
  modelName: string;
} {
  const baseUrl = process.env.OLLAMA_HOST ?? "http://localhost:11434";
  const provider = new OllamaProvider(model, baseUrl);
  return { provider, modelName: model };
}
