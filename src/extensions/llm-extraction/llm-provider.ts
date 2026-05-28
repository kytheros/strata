/**
 * LLM provider interface and implementations for community edition.
 *
 * Provides the shared LlmProvider interface, LlmError class, and
 * an OllamaProvider for local model inference via Ollama REST API.
 */

/** Options for LLM completion calls */
export interface CompletionOptions {
  maxTokens?: number;
  temperature?: number;
  /** Timeout in milliseconds (default: 10000) */
  timeoutMs?: number;
  /** Request JSON output from the model (Gemini: responseMimeType, OpenAI: response_format) */
  jsonMode?: boolean;
  /**
   * Ollama-only: how long to keep the model loaded after this request.
   * Accepts duration strings ("5m", "1h", "24h") or "-1" for forever.
   * Default: undefined (Ollama uses its server-side default of 5 minutes,
   * or the OLLAMA_KEEP_ALIVE env var if set).
   *
   * Setting this to "-1" or a long duration ("24h") prevents the model
   * from being evicted between calls — critical for long benchmark runs
   * where any single Q exceeding 5 min would force a reload + likely fail.
   */
  keepAlive?: string;
}

/** Result from a completion call, with optional metadata */
export interface CompletionResult {
  text: string;
  model: string;
  /** Whether JSON repair was needed on the response */
  repaired?: boolean;
}

/** LLM provider interface */
export interface LlmProvider {
  /** Provider name */
  readonly name: string;
  /** Generate a completion from a prompt */
  complete(prompt: string, options?: CompletionOptions): Promise<string>;
}

/**
 * Error class for LLM-related failures (timeouts, rate limits, etc.).
 */
export class LlmError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/**
 * Ollama REST API provider (local LLM, http://localhost:11434 default).
 *
 * Calls the /api/generate endpoint with stream=false for synchronous responses.
 * Suitable for local distilled models (e.g., strata-extraction-7b via Ollama).
 */
export class OllamaProvider implements LlmProvider {
  readonly name = "ollama";
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(model = "llama3.2", baseUrl = "http://localhost:11434") {
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async complete(prompt: string, options: CompletionOptions = {}): Promise<string> {
    const { temperature = 0.2, timeoutMs = 30000, maxTokens, jsonMode, keepAlive } = options;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Build Ollama's options object. num_predict caps output tokens
      // (critical — without it Ollama defaults to unlimited generation,
      // causing long extraction prompts to run past the HTTP timeout
      // even when the model could produce a valid short answer).
      const ollamaOptions: Record<string, number> = { temperature };
      if (typeof maxTokens === "number" && maxTokens > 0) {
        ollamaOptions.num_predict = maxTokens;
      }

      // Request body for Ollama /api/generate. format: "json" enables
      // Ollama's native JSON-constrained sampling, which produces
      // parseable JSON directly (no markdown fences, no prose preamble).
      const requestBody: Record<string, unknown> = {
        model: this.model,
        prompt,
        stream: false,
        options: ollamaOptions,
      };
      if (jsonMode) {
        requestBody.format = "json";
      }

      // keep_alive precedence: explicit option > OLLAMA_KEEP_ALIVE env var > Ollama default (5m).
      // For long-running benchmark loops, set this to "-1" or "24h" to prevent
      // the model from being evicted mid-run, which causes "fetch failed" on
      // the next request when node tries to reuse a stale keep-alive connection.
      const effectiveKeepAlive = keepAlive ?? process.env.OLLAMA_KEEP_ALIVE;
      if (effectiveKeepAlive !== undefined) {
        requestBody.keep_alive = effectiveKeepAlive;
      }

      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        // Connection: close forces a new TCP connection per request.
        // Without this, node's fetch reuses keep-alive connections that
        // Ollama may have already closed on its side (idle timeout, model
        // swap), surfacing as ECONNRESET / "fetch failed" on the next call.
        headers: { "Content-Type": "application/json", "Connection": "close" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new LlmError(
          `Ollama API error: ${response.status} ${body}`,
          this.name,
          response.status
        );
      }

      const data = (await response.json()) as { response: string };

      if (!data.response) {
        throw new LlmError("No response content from Ollama", this.name);
      }

      return data.response;
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new LlmError(
          `Ollama request timed out after ${timeoutMs}ms`,
          this.name
        );
      }
      throw new LlmError(
        `Ollama request failed: ${error instanceof Error ? error.message : String(error)}`,
        this.name
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
