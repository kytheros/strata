/**
 * Gemini LLM provider for community edition.
 *
 * Uses raw fetch() — no SDK dependency.
 * Gate: returns null from getCachedGeminiProvider() when GEMINI_API_KEY is not set.
 * Follows the same pattern as GeminiEmbedder in ../embeddings/gemini-embedder.ts.
 */

import type { CompletionOptions, LlmProvider } from "./llm-provider.js";
import { LlmError } from "./llm-provider.js";

/** Gemini API response shape */
interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  error?: { message: string; code: number };
}

/**
 * Gemini provider via generativelanguage.googleapis.com (API key auth).
 * Community edition: API key only, no Vertex AI / ADC cascade.
 */
export class GeminiProvider implements LlmProvider {
  readonly name = "gemini";
  private readonly model: string;
  private readonly apiKey: string;
  // Overridable for testing
  private fetchFn: typeof globalThis.fetch;

  constructor(options: {
    apiKey: string;
    model?: string;
    fetchFn?: typeof globalThis.fetch;
  }) {
    this.apiKey = options.apiKey;
    this.model = options.model || "gemini-2.5-flash";
    this.fetchFn = options.fetchFn || globalThis.fetch.bind(globalThis);
  }

  async complete(
    prompt: string,
    options: CompletionOptions = {}
  ): Promise<string> {
    const { maxTokens = 2048, temperature = 0.2, timeoutMs = 10000 } = options;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;

      const response = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature,
            maxOutputTokens: maxTokens,
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new LlmError(
          `Gemini API error: ${response.status} ${body}`,
          this.name,
          response.status
        );
      }

      const data = (await response.json()) as GeminiResponse;

      if (data.error) {
        throw new LlmError(
          `Gemini API error: ${data.error.message}`,
          this.name,
          data.error.code
        );
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new LlmError("No text content in Gemini response", this.name);
      }

      return text;
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new LlmError(
          `Gemini request timed out after ${timeoutMs}ms`,
          this.name
        );
      }
      throw new LlmError(
        `Gemini request failed: ${error instanceof Error ? error.message : String(error)}`,
        this.name
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

// -- Auto-detection & caching --

let cachedProvider: LlmProvider | null | undefined;

/**
 * Get a cached Gemini provider instance.
 * Returns a GeminiProvider when GEMINI_API_KEY is set, null otherwise.
 * Probes once, caches the result.
 */
export async function getCachedGeminiProvider(): Promise<LlmProvider | null> {
  if (cachedProvider !== undefined) return cachedProvider;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    cachedProvider = null;
    return null;
  }

  cachedProvider = new GeminiProvider({ apiKey });
  return cachedProvider;
}

/** Reset the cached provider (for testing) */
export function resetGeminiProviderCache(): void {
  cachedProvider = undefined;
}
