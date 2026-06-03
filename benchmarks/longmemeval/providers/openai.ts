/**
 * OpenAI LLM provider for LongMemEval benchmark.
 *
 * Uses raw fetch() — no SDK dependency.
 * Follows the same pattern as GeminiProvider and AnthropicProvider.
 *
 * Required for LongMemEval score comparability: all published scores
 * (OMEGA 95.4%, Hindsight 91.4%, Zep 71.2%) use GPT-4o as the judge.
 */

import type { CompletionOptions, LlmProvider } from "../../../src/extensions/llm-extraction/llm-provider.js";
import { LlmError } from "../../../src/extensions/llm-extraction/llm-provider.js";

/** Extended options for benchmark providers that support system/user message split */
export interface BenchmarkCompletionOptions extends CompletionOptions {
  /** Optional system prompt sent as a separate system message (improves GPT-4o grounding) */
  systemPrompt?: string;
}

/** OpenAI Chat Completions API response shape */
interface OpenAIResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
  error?: { message: string; type: string; code: string };
}

/**
 * OpenAI provider via api.openai.com (API key auth).
 * Calls the Chat Completions API with raw fetch().
 *
 * Default model: gpt-4o-2024-08-06 — the exact model used by the
 * official LongMemEval eval script for judge scoring.
 */
export class OpenAIProvider implements LlmProvider {
  readonly name = "openai";
  private readonly model: string;
  private readonly apiKey: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(options: {
    apiKey: string;
    model?: string;
    fetchFn?: typeof globalThis.fetch;
  }) {
    this.apiKey = options.apiKey;
    this.model = options.model || "gpt-4o-2024-08-06";
    this.fetchFn = options.fetchFn || globalThis.fetch.bind(globalThis);
  }

  async complete(
    prompt: string,
    options: BenchmarkCompletionOptions = {}
  ): Promise<string> {
    const { maxTokens = 2048, temperature = 0, timeoutMs = 30000, systemPrompt } = options;

    // Reasoning models (gpt-5-*, o-series) only support temperature=1
    // and use max_completion_tokens instead of max_tokens
    const isReasoningModel =
      this.model.startsWith("gpt-5") || this.model.startsWith("o");

    // Build messages array: optional system message + user message
    const messages: Array<{ role: string; content: string }> = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchFn(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            ...(isReasoningModel ? {} : { temperature }),
            ...(isReasoningModel
              ? { max_completion_tokens: maxTokens }
              : { max_tokens: maxTokens }),
            n: 1,
            messages,
          }),
          signal: controller.signal,
        }
      );

      if (response.status === 429) {
        throw new LlmError("OpenAI rate limit exceeded", this.name, 429);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new LlmError(
          `OpenAI API error: ${response.status} ${body}`,
          this.name,
          response.status
        );
      }

      const data = (await response.json()) as OpenAIResponse;

      if (data.error) {
        throw new LlmError(
          `OpenAI API error: ${data.error.message}`,
          this.name
        );
      }

      const choice = data.choices?.[0];
      const text = choice?.message?.content;
      if (!text) {
        // Reasoning models may exhaust tokens on reasoning, leaving content null
        const finishReason = (choice as any)?.finish_reason || "unknown";
        throw new LlmError(
          `No text content in OpenAI response (finish_reason: ${finishReason})`,
          this.name
        );
      }

      return text;
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new LlmError(
          `OpenAI request timed out after ${timeoutMs}ms`,
          this.name
        );
      }
      throw new LlmError(
        `OpenAI request failed: ${error instanceof Error ? error.message : String(error)}`,
        this.name
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
