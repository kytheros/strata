import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HybridProvider } from "../../../src/extensions/llm-extraction/hybrid-provider.js";
import type { LlmProvider, CompletionOptions } from "../../../src/extensions/llm-extraction/llm-provider.js";

/**
 * Regression tests for HybridProvider's timeout-override behavior.
 *
 * Prior review flagged that `localTimeoutMs` from the factory was being
 * silently overridden by a caller-supplied `timeoutMs: 30000`, making the
 * 180s configured-for-local-Gemma timeout dead config. The fix in 3856bf0
 * spreads caller options first and then explicitly sets
 * `timeoutMs: this.config.localTimeoutMs`, so the factory wins.
 *
 * These tests lock in that ordering so a future refactor cannot silently
 * reintroduce the bug.
 */

describe("HybridProvider — timeout override", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("forces localTimeoutMs on local calls even when caller passes a smaller timeoutMs", async () => {
    // Capture the options that OllamaProvider actually receives.
    // OllamaProvider builds its fetch request using timeoutMs from options,
    // so we intercept fetch and inspect the AbortSignal's parent timeout via
    // the request body — but the simplest test is to wrap fetch and assert
    // that the provider doesn't timeout within the caller's shorter window.

    // Fake fetch that resolves after 100ms with a successful Ollama response.
    globalThis.fetch = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return new Response(JSON.stringify({ response: '{"ok":true}', done: true }));
    });

    const frontier: LlmProvider = {
      name: "frontier",
      async complete() {
        throw new Error("frontier should not have been called");
      },
    };

    const hybrid = new HybridProvider({
      localUrl: "http://localhost:11434",
      localModel: "test-model",
      frontierProvider: frontier,
      // Local timeout is generous; caller's attempt to shorten it must be ignored.
      localTimeoutMs: 5_000,
      validateOutput: (raw: string) => {
        try {
          JSON.parse(raw);
          return true;
        } catch {
          return false;
        }
      },
    });

    // Caller passes a 50ms timeout — if the spread order were reversed, the
    // local call would abort before the 100ms fetch resolves and fall back.
    // With the current override, localTimeoutMs (5000) wins and the call
    // completes cleanly.
    const result = await hybrid.complete("test prompt", {
      timeoutMs: 50,
      maxTokens: 100,
    } as CompletionOptions);

    expect(result).toBe('{"ok":true}');
  });

  it("passes the caller's timeoutMs through to the frontier fallback", async () => {
    // First fetch (local) rejects — trigger fallback path.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("local ollama unreachable");
    });

    let frontierReceivedTimeoutMs: number | undefined;
    const frontier: LlmProvider = {
      name: "frontier",
      async complete(_prompt: string, options?: CompletionOptions) {
        frontierReceivedTimeoutMs = options?.timeoutMs;
        return "frontier-response";
      },
    };

    const hybrid = new HybridProvider({
      localUrl: "http://localhost:11434",
      localModel: "test-model",
      frontierProvider: frontier,
      localTimeoutMs: 5_000,
      validateOutput: () => true,
    });

    const prevStrict = process.env.STRATA_HYBRID_STRICT;
    delete process.env.STRATA_HYBRID_STRICT;
    try {
      const result = await hybrid.complete("test", { timeoutMs: 7_500 });
      expect(result).toBe("frontier-response");
      // Frontier receives the caller's timeout, not the local one.
      expect(frontierReceivedTimeoutMs).toBe(7_500);
    } finally {
      if (prevStrict !== undefined) process.env.STRATA_HYBRID_STRICT = prevStrict;
    }
  });
});
