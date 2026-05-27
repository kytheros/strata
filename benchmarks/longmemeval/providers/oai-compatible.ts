/**
 * Generic OpenAI-compatible LLM provider for the LongMemEval benchmark.
 *
 * Talks to any endpoint that implements the OpenAI Chat Completions API:
 * OpenRouter, Together, Fireworks, Groq, DeepInfra, Mistral, xAI, vLLM,
 * LMStudio, plus any custom endpoint via the LONGMEMEVAL_OAI_COMPAT_*
 * env-var override (identifier prefix `custom:`).
 *
 * Mirrors the shape of `openai.ts` but with configurable baseURL +
 * per-provider headers. Uses raw fetch() — no SDK dependency, per
 * monorepo HTTP client policy.
 *
 * Spec: specs/2026-05-27-benchmark-multi-model-provider-design.md §7
 */

import type { LlmProvider } from "../../../src/extensions/llm-extraction/llm-provider.js";
import { LlmError } from "../../../src/extensions/llm-extraction/llm-provider.js";
import type { BenchmarkCompletionOptions } from "./openai.js";

interface OaiCompatibleResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  error?: { message?: string; type?: string; code?: string };
}

export interface OaiCompatibleOptions {
  /** Short provider name from the registry, e.g. "openrouter" or "custom". */
  providerName: string;
  /** Full base URL including /v1 path component. */
  baseURL: string;
  /** API key (Bearer auth). */
  apiKey: string;
  /** Model identifier as the provider expects it. */
  model: string;
  /** Extra headers (e.g., OpenRouter HTTP-Referer + X-Title). */
  headers?: Record<string, string>;
  /** Optional fetch override for tests. */
  fetchFn?: typeof globalThis.fetch;
}

/**
 * OpenAI-compatible provider. `name` is fixed to "oai-compatible" so
 * prompt-variant resolution in answer.ts can dispatch uniformly across
 * all backed endpoints. The original short name is preserved in
 * `providerName` for logging and debugging.
 */
export class OaiCompatibleProvider implements LlmProvider {
  readonly name = "oai-compatible";
  readonly providerName: string;
  readonly model: string;
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly extraHeaders: Record<string, string>;
  private fetchFn: typeof globalThis.fetch;

  constructor(options: OaiCompatibleOptions) {
    this.providerName = options.providerName;
    this.baseURL = options.baseURL.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.extraHeaders = options.headers ?? {};
    this.fetchFn = options.fetchFn || globalThis.fetch.bind(globalThis);
  }

  async complete(
    prompt: string,
    options: BenchmarkCompletionOptions = {}
  ): Promise<string> {
    const { maxTokens = 2048, temperature = 0, timeoutMs = 120000, systemPrompt } = options;

    const messages: Array<{ role: string; content: string }> = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: prompt });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchFn(
        `${this.baseURL}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            ...this.extraHeaders,
          },
          body: JSON.stringify({
            model: this.model,
            temperature,
            max_tokens: maxTokens,
            n: 1,
            messages,
          }),
          signal: controller.signal,
        }
      );

      if (response.status === 429) {
        throw new LlmError(
          `${this.providerName} rate limit exceeded`,
          this.name,
          429
        );
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new LlmError(
          `${this.providerName} API error: ${response.status} ${body}`,
          this.name,
          response.status
        );
      }

      const data = (await response.json()) as OaiCompatibleResponse;

      if (data.error) {
        throw new LlmError(
          `${this.providerName} API error: ${data.error.message ?? "unknown"}`,
          this.name
        );
      }

      const choice = data.choices?.[0];
      const text = choice?.message?.content;
      if (!text) {
        const finishReason = choice?.finish_reason ?? "unknown";
        throw new LlmError(
          `No text content in ${this.providerName} response (finish_reason: ${finishReason})`,
          this.name
        );
      }

      return text;
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new LlmError(
          `${this.providerName} request timed out after ${timeoutMs}ms`,
          this.name
        );
      }
      throw new LlmError(
        `${this.providerName} request failed: ${error instanceof Error ? error.message : String(error)}`,
        this.name
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
