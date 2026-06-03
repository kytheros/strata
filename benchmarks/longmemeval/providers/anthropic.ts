/**
 * Anthropic LLM provider for LongMemEval benchmark.
 *
 * Uses raw fetch() — no SDK dependency.
 * Follows the same pattern as GeminiProvider in src/extensions/llm-extraction/gemini-provider.ts.
 *
 * Supports extended thinking via the `thinkingBudget` constructor option.
 * When enabled, the model gets a separate token budget for internal reasoning
 * before producing its answer. Thinking content is discarded — only the final
 * text response is returned.
 *
 * Anthropic API constraints for thinking:
 * - temperature MUST be 1 (enforced by the API)
 * - thinking budget is separate from max_tokens
 * - Response contains both "thinking" and "text" content blocks
 */

import type { CompletionOptions, LlmProvider } from "../../../src/extensions/llm-extraction/llm-provider.js";
import { LlmError } from "../../../src/extensions/llm-extraction/llm-provider.js";

/** Extended options for benchmark providers that support system/user message split */
export interface BenchmarkCompletionOptions extends CompletionOptions {
  /** Optional system prompt sent as a separate system message (improves Claude grounding) */
  systemPrompt?: string;
}

/** Anthropic Messages API response shape */
interface AnthropicResponse {
  content?: Array<{ type: string; text?: string; thinking?: string }>;
  error?: { type: string; message: string };
  type?: string;
}

/**
 * Anthropic provider via api.anthropic.com (API key auth).
 * Calls the Messages API with raw fetch().
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  private readonly model: string;
  private readonly apiKey: string;
  private readonly thinkingBudget: number | null;
  private fetchFn: typeof globalThis.fetch;

  constructor(options: {
    apiKey: string;
    model?: string;
    /** Token budget for extended thinking. When set, enables thinking mode. */
    thinkingBudget?: number;
    fetchFn?: typeof globalThis.fetch;
  }) {
    this.apiKey = options.apiKey;
    this.model = options.model || "claude-sonnet-4-6";
    this.thinkingBudget = options.thinkingBudget ?? null;
    this.fetchFn = options.fetchFn || globalThis.fetch.bind(globalThis);
  }

  async complete(
    prompt: string,
    options: BenchmarkCompletionOptions = {}
  ): Promise<string> {
    const { maxTokens = 2048, temperature = 0, timeoutMs = 30000, systemPrompt } = options;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    // Build request body — thinking mode requires temperature=1 and
    // max_tokens > budget_tokens (max_tokens covers thinking + answer)
    const effectiveMaxTokens = this.thinkingBudget
      ? this.thinkingBudget + maxTokens
      : maxTokens;

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: effectiveMaxTokens,
      temperature: this.thinkingBudget ? 1 : temperature,
      messages: [{ role: "user", content: prompt }],
    };

    // Add system prompt as a separate top-level field (Anthropic API format)
    if (systemPrompt) {
      body.system = systemPrompt;
    }

    if (this.thinkingBudget) {
      body.thinking = {
        type: "enabled",
        budget_tokens: this.thinkingBudget,
      };
    }

    try {
      const response = await this.fetchFn(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }
      );

      if (response.status === 429) {
        throw new LlmError(
          "Anthropic rate limit exceeded",
          this.name,
          429
        );
      }

      if (!response.ok) {
        const respBody = await response.text().catch(() => "");
        throw new LlmError(
          `Anthropic API error: ${response.status} ${respBody}`,
          this.name,
          response.status
        );
      }

      const data = (await response.json()) as AnthropicResponse;

      if (data.error) {
        throw new LlmError(
          `Anthropic API error: ${data.error.message}`,
          this.name
        );
      }

      // Extract the text block, skipping any thinking blocks
      const text = data.content?.find((c) => c.type === "text")?.text;
      if (!text) {
        throw new LlmError("No text content in Anthropic response", this.name);
      }

      return text;
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new LlmError(
          `Anthropic request timed out after ${timeoutMs}ms`,
          this.name
        );
      }
      throw new LlmError(
        `Anthropic request failed: ${error instanceof Error ? error.message : String(error)}`,
        this.name
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
