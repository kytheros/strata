/**
 * OpenAI-compatible embedding provider.
 *
 * Sends embeddings requests to any server that implements the OpenAI
 * `/v1/embeddings` API shape — e.g. Ollama, LM Studio, llama.cpp server,
 * text-embeddings-inference, or any other provider that speaks the same
 * protocol.
 *
 * Security:
 * - Input text is sanitized before sending so secrets don't leave the machine
 *   (spec §23.2, default ON via the shared Sanitizer).
 * - Authorization header is sent ONLY when apiKey is non-empty; never an
 *   empty Bearer token.
 * - Response embedding length is validated against the configured dimensions;
 *   throws a clear error on mismatch.
 *
 * Dependency: native `fetch` only — no third-party HTTP clients.
 */

import type { EmbeddingProvider } from "../vector-search/embedding-provider.js";
import { Sanitizer } from "../../sanitizer/sanitizer.js";

/** Constructor options for OpenAiCompatibleProvider. */
export interface OpenAiCompatibleOptions {
  /** Base URL of the OpenAI-compatible server, e.g. "http://localhost:1234/v1". */
  baseUrl: string;
  /** Model name to pass in the request body. */
  model: string;
  /** Expected embedding dimensionality. Validated on every response. */
  dimensions: number;
  /** API key for Bearer auth. Omit or leave empty to skip auth header. */
  apiKey?: string;
  /**
   * Injected fetch function — use in tests to avoid real network calls.
   * Defaults to the global `fetch`.
   */
  fetchFn?: typeof globalThis.fetch;
  /**
   * Whether to sanitize input text before sending.
   * Defaults to true (spec §23.2).
   */
  sanitize?: boolean;
}

/** Shared sanitizer instance (module-level is fine — it's stateless). */
const sanitizer = new Sanitizer();

/**
 * EmbeddingProvider backed by any OpenAI-compatible `/v1/embeddings` endpoint.
 *
 * - `supportsQuantization` is always false (not Gemini).
 * - Input is sanitized before leaving the machine (default ON).
 * - Authorization is only sent when apiKey is non-empty.
 * - Response length is validated; throws /dimension/i on mismatch.
 */
export class OpenAiCompatibleProvider implements EmbeddingProvider {
  readonly supportsQuantization = false;

  readonly modelName: string;
  readonly dimensions: number;

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly shouldSanitize: boolean;

  constructor(opts: OpenAiCompatibleOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, ""); // strip trailing slashes
    this.modelName = opts.model;
    this.dimensions = opts.dimensions;
    this.apiKey = opts.apiKey && opts.apiKey.length > 0 ? opts.apiKey : undefined;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
    this.shouldSanitize = opts.sanitize !== false; // default ON
  }

  async embed(text: string, _taskType?: string): Promise<Float32Array> {
    const [result] = await this.embedBatch([text], _taskType);
    return result;
  }

  async embedBatch(texts: string[], _taskType?: string): Promise<Float32Array[]> {
    // Sanitize inputs before they leave the machine (strips secrets, API keys, etc.)
    const inputs = this.shouldSanitize
      ? texts.map((t) => sanitizer.sanitize(t))
      : texts;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // Conditional auth: only send when apiKey is set (never empty Bearer)
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const body = JSON.stringify({
      model: this.modelName,
      input: inputs.length === 1 ? inputs[0] : inputs,
      dimensions: this.dimensions,
    });

    const url = `${this.baseUrl}/embeddings`;
    const response = await this.fetchFn(url, {
      method: "POST",
      headers,
      body,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "(no body)");
      throw new Error(
        `OpenAI-compatible embedding request failed: ${response.status} ${response.statusText} — ${text}`
      );
    }

    const json = await response.json() as { data: Array<{ embedding: number[] }> };

    if (!Array.isArray(json.data) || json.data.length === 0) {
      throw new Error("OpenAI-compatible embedding response has no data array");
    }

    // Validate and convert each embedding
    return json.data.map((item, i) => {
      const emb = item.embedding;
      if (!Array.isArray(emb) || emb.length !== this.dimensions) {
        throw new Error(
          `OpenAI-compatible embedding dimension mismatch at index ${i}: ` +
          `expected ${this.dimensions}, got ${Array.isArray(emb) ? emb.length : "non-array"}`
        );
      }
      return new Float32Array(emb);
    });
  }
}
