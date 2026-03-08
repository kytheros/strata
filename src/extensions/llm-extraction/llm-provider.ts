/** Type stub for community edition — actual implementation is in strata-pro. */
export interface CompletionOptions {
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface LlmProvider {
  readonly name: string;
  complete(prompt: string, options?: CompletionOptions): Promise<string>;
}

/**
 * Error class for LLM-related failures (timeouts, rate limits, etc.).
 */
export class LlmError extends Error {
  constructor(
    public readonly code: string,
    public readonly provider: string,
    message?: string,
  ) {
    super(message ?? `LLM error [${code}] from ${provider}`);
    this.name = "LlmError";
  }
}
