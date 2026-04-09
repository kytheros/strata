/**
 * Hybrid LLM provider: local-first with frontier fallback.
 *
 * Tries a local Ollama model first, validates the JSON output,
 * and falls back to a frontier provider (e.g., Gemini) on failure.
 * This enables distilled local models to handle routine extraction
 * while keeping frontier quality as a safety net.
 */

import type { LlmProvider, CompletionOptions } from "./llm-provider.js";
import { OllamaProvider, LlmError } from "./llm-provider.js";

export interface HybridProviderConfig {
  /** Ollama base URL (default: http://localhost:11434) */
  localUrl: string;
  /** Model name loaded in Ollama (e.g., strata-extraction-7b) */
  localModel: string;
  /** Frontier provider to fall back to */
  frontierProvider: LlmProvider;
  /** Validate model output — return true if output is usable */
  validateOutput: (raw: string) => boolean;
  /** Timeout for local model calls in ms (default: 15000) */
  localTimeoutMs: number;
}

export class HybridProvider implements LlmProvider {
  readonly name = "hybrid";
  private local: OllamaProvider;
  private config: HybridProviderConfig;

  constructor(config: HybridProviderConfig) {
    this.config = config;
    this.local = new OllamaProvider(config.localModel, config.localUrl);
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    // 1. Try local model
    //
    // Always force jsonMode=true for local calls because HybridProvider's
    // only use case is JSON-validated output (its validateOutput predicate
    // is checked below). Ollama's native JSON mode constrains sampling to
    // produce parseable JSON, eliminating markdown fences and prose
    // preambles that would otherwise fail validation and trigger
    // unnecessary frontier fallbacks.
    try {
      const raw = await this.local.complete(prompt, {
        ...options,
        timeoutMs: this.config.localTimeoutMs,
        jsonMode: true,
      });

      // 2. Validate output (must be parseable JSON with expected structure)
      if (this.config.validateOutput(raw)) {
        return raw; // Local model succeeded
      }

      // 3. Validation failed — fall through to frontier
      console.warn(
        "[HybridProvider] local model output failed validation, falling back to frontier"
      );
    } catch (err) {
      // Ollama not running, model not loaded, timeout, etc. — fall through silently
      if (err instanceof LlmError) {
        console.warn(
          `[HybridProvider] local model error (${err.statusCode ?? "unknown"}), falling back to frontier`
        );
      }
    }

    // 4. Frontier fallback
    return this.config.frontierProvider.complete(prompt, options);
  }
}
