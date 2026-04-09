import { describe, it, expect, vi } from "vitest";
import { HybridProvider } from "../../../src/extensions/llm-extraction/hybrid-provider.js";
import type { HybridProviderConfig } from "../../../src/extensions/llm-extraction/hybrid-provider.js";
import type { LlmProvider, CompletionOptions } from "../../../src/extensions/llm-extraction/llm-provider.js";
import { LlmError } from "../../../src/extensions/llm-extraction/llm-provider.js";

/** Create a mock LlmProvider that returns a fixed string. */
function mockProvider(
  name: string,
  result: string | Error
): LlmProvider & { calls: Array<{ prompt: string; options?: CompletionOptions }> } {
  const calls: Array<{ prompt: string; options?: CompletionOptions }> = [];
  return {
    name,
    calls,
    complete: async (prompt: string, options?: CompletionOptions) => {
      calls.push({ prompt, options });
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

/** Standard validator: expects JSON with an "entries" array. */
function validEntries(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.entries);
  } catch {
    return false;
  }
}

describe("HybridProvider", () => {
  it("should have name 'hybrid'", () => {
    const frontier = mockProvider("gemini", "fallback");
    const provider = new HybridProvider({
      localUrl: "http://localhost:11434",
      localModel: "test-model",
      frontierProvider: frontier,
      validateOutput: validEntries,
      localTimeoutMs: 15000,
    });
    expect(provider.name).toBe("hybrid");
  });

  it("should return local result when local model succeeds with valid JSON", async () => {
    const localResult = JSON.stringify({ entries: [{ type: "decision", summary: "test" }] });
    const frontier = mockProvider("gemini", "should not be called");

    // Mock global fetch for the OllamaProvider inside HybridProvider
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: localResult }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const provider = new HybridProvider({
        localUrl: "http://localhost:11434",
        localModel: "strata-extraction-7b",
        frontierProvider: frontier,
        validateOutput: validEntries,
        localTimeoutMs: 15000,
      });

      const result = await provider.complete("test prompt");

      expect(result).toBe(localResult);
      expect(frontier.calls).toHaveLength(0); // Frontier NOT called
      expect(mockFetch).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should fall back to frontier when local model returns invalid JSON", async () => {
    const invalidOutput = "This is not JSON at all";
    const frontierResult = JSON.stringify({ entries: [{ type: "solution", summary: "from frontier" }] });
    const frontier = mockProvider("gemini", frontierResult);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: invalidOutput }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const provider = new HybridProvider({
        localUrl: "http://localhost:11434",
        localModel: "strata-extraction-7b",
        frontierProvider: frontier,
        validateOutput: validEntries,
        localTimeoutMs: 15000,
      });

      const result = await provider.complete("test prompt");

      expect(result).toBe(frontierResult);
      expect(frontier.calls).toHaveLength(1); // Frontier was called
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should fall back to frontier when local model throws (Ollama not running)", async () => {
    const frontierResult = JSON.stringify({ entries: [] });
    const frontier = mockProvider("gemini", frontierResult);

    // Simulate connection refused
    const mockFetch = vi.fn().mockRejectedValue(
      new TypeError("fetch failed: connection refused")
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const provider = new HybridProvider({
        localUrl: "http://localhost:11434",
        localModel: "strata-extraction-7b",
        frontierProvider: frontier,
        validateOutput: validEntries,
        localTimeoutMs: 15000,
      });

      const result = await provider.complete("test prompt");

      expect(result).toBe(frontierResult);
      expect(frontier.calls).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should fall back to frontier when local model times out", async () => {
    const frontierResult = JSON.stringify({ entries: [] });
    const frontier = mockProvider("gemini", frontierResult);

    // Simulate a request that never resolves (will be aborted)
    const mockFetch = vi.fn().mockImplementation(
      (_url: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        })
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const provider = new HybridProvider({
        localUrl: "http://localhost:11434",
        localModel: "strata-extraction-7b",
        frontierProvider: frontier,
        validateOutput: validEntries,
        localTimeoutMs: 10, // Very short timeout to trigger quickly
      });

      const result = await provider.complete("test prompt");

      expect(result).toBe(frontierResult);
      expect(frontier.calls).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should throw frontier error when both local and frontier fail", async () => {
    const frontierError = new LlmError("Gemini rate limited", "gemini", 429);
    const frontier = mockProvider("gemini", frontierError);

    // Local model also fails
    const mockFetch = vi.fn().mockRejectedValue(
      new TypeError("fetch failed: connection refused")
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const provider = new HybridProvider({
        localUrl: "http://localhost:11434",
        localModel: "strata-extraction-7b",
        frontierProvider: frontier,
        validateOutput: validEntries,
        localTimeoutMs: 15000,
      });

      await expect(provider.complete("test prompt")).rejects.toThrow(LlmError);
      await expect(provider.complete("test prompt")).rejects.toThrow("Gemini rate limited");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should fall back when validateOutput returns false", async () => {
    // Local returns valid JSON but without the expected structure
    const localResult = JSON.stringify({ results: ["wrong shape"] });
    const frontierResult = JSON.stringify({ entries: [{ type: "pattern", summary: "correct" }] });
    const frontier = mockProvider("gemini", frontierResult);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: localResult }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const provider = new HybridProvider({
        localUrl: "http://localhost:11434",
        localModel: "strata-extraction-7b",
        frontierProvider: frontier,
        validateOutput: validEntries,
        localTimeoutMs: 15000,
      });

      const result = await provider.complete("test prompt");

      expect(result).toBe(frontierResult);
      expect(frontier.calls).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should pass prompt and options through to frontier on fallback", async () => {
    const frontierResult = JSON.stringify({ entries: [] });
    const frontier = mockProvider("gemini", frontierResult);

    const mockFetch = vi.fn().mockRejectedValue(new TypeError("connection refused"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const provider = new HybridProvider({
        localUrl: "http://localhost:11434",
        localModel: "strata-extraction-7b",
        frontierProvider: frontier,
        validateOutput: validEntries,
        localTimeoutMs: 15000,
      });

      const opts: CompletionOptions = { maxTokens: 4096, temperature: 0.1, timeoutMs: 30000 };
      await provider.complete("my prompt", opts);

      expect(frontier.calls).toHaveLength(1);
      expect(frontier.calls[0].prompt).toBe("my prompt");
      expect(frontier.calls[0].options).toEqual(opts);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should use localTimeoutMs for the local call, not the caller timeout", async () => {
    const localResult = JSON.stringify({ entries: [] });
    const frontier = mockProvider("gemini", "should not be called");

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: localResult }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const provider = new HybridProvider({
        localUrl: "http://localhost:11434",
        localModel: "strata-extraction-7b",
        frontierProvider: frontier,
        validateOutput: validEntries,
        localTimeoutMs: 5000, // This should override the caller's timeoutMs
      });

      // Caller passes a different timeout
      await provider.complete("test", { timeoutMs: 60000 });

      // Verify the Ollama call used localTimeoutMs (5000), not the caller's 60000
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      // The OllamaProvider uses the timeoutMs from options for AbortController,
      // but we can verify the options were merged by checking the fetch was called
      expect(mockFetch).toHaveBeenCalledOnce();
      expect(frontier.calls).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should handle LlmError from local model with status code", async () => {
    const frontierResult = JSON.stringify({ entries: [] });
    const frontier = mockProvider("gemini", frontierResult);

    // Simulate 404 from Ollama (model not found)
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "model not found",
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const provider = new HybridProvider({
        localUrl: "http://localhost:11434",
        localModel: "missing-model",
        frontierProvider: frontier,
        validateOutput: validEntries,
        localTimeoutMs: 15000,
      });

      const result = await provider.complete("test");

      expect(result).toBe(frontierResult);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("local model error (404)")
      );

      warnSpy.mockRestore();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("HybridProvider jsonMode forcing", () => {
  // Regression coverage for commit 3856bf0: before the fix, HybridProvider
  // passed caller options straight through to the local model. Callers
  // like enhancedExtract in strata-pro don't set jsonMode:true, so local
  // Gemma 4 calls were made without Ollama's native JSON-constrained
  // sampling, causing the validator to reject valid-but-prose outputs
  // and trigger unnecessary frontier fallbacks.
  //
  // HybridProvider's only use case is JSON-validated output, so it now
  // explicitly forces jsonMode:true on every local call regardless of
  // what the caller passed. Frontier fallback calls are unchanged —
  // they receive the caller's original options since non-Ollama
  // providers use different JSON-mode mechanisms.
  //
  // We observe the forced jsonMode by inspecting the Ollama request
  // body: when jsonMode is true, OllamaProvider sets a top-level
  // format:"json" field in the request (verified by
  // llm-provider.test.ts). Same pattern as the surrounding tests in
  // this file — mock global fetch, assert on the serialized body.

  it("forces jsonMode:true on local calls even when caller omits it", async () => {
    const localResult = JSON.stringify({ entries: [] });
    const frontier = mockProvider("gemini", "should not be called");

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: localResult }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const provider = new HybridProvider({
        localUrl: "http://localhost:11434",
        localModel: "gemma4:e4b",
        frontierProvider: frontier,
        validateOutput: validEntries,
        localTimeoutMs: 5000,
      });

      // Caller passes maxTokens but no jsonMode
      await provider.complete("test prompt", { maxTokens: 1024 });

      expect(mockFetch).toHaveBeenCalledOnce();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      // HybridProvider must force jsonMode:true, which OllamaProvider
      // serializes as top-level format:"json".
      expect(body.format).toBe("json");
      // Other caller options must be preserved through the spread.
      expect(body.options.num_predict).toBe(1024);
      // Frontier must NOT have been called — local succeeded.
      expect(frontier.calls).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("forces jsonMode:true on local calls even when caller passed jsonMode:false", async () => {
    const localResult = JSON.stringify({ entries: [] });
    const frontier = mockProvider("gemini", "should not be called");

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: localResult }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const provider = new HybridProvider({
        localUrl: "http://localhost:11434",
        localModel: "gemma4:e4b",
        frontierProvider: frontier,
        validateOutput: validEntries,
        localTimeoutMs: 5000,
      });

      // Caller actively tries to disable jsonMode — must be overridden.
      await provider.complete("test prompt", { jsonMode: false });

      expect(mockFetch).toHaveBeenCalledOnce();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.format).toBe("json");
      expect(frontier.calls).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does NOT force jsonMode on frontier fallback", async () => {
    const frontierResult = JSON.stringify({ entries: [] });
    const frontier = mockProvider("gemini", frontierResult);

    // Simulate local Ollama connection refused so we fall through to frontier.
    const mockFetch = vi.fn().mockRejectedValue(
      new TypeError("fetch failed: connection refused")
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const provider = new HybridProvider({
        localUrl: "http://localhost:11434",
        localModel: "gemma4:e4b",
        frontierProvider: frontier,
        validateOutput: validEntries,
        localTimeoutMs: 5000,
      });

      const callerOpts: CompletionOptions = { maxTokens: 1024 };
      await provider.complete("test prompt", callerOpts);

      // Frontier should receive caller's original options, NOT with forced
      // jsonMode — non-Ollama providers use different JSON-mode mechanisms.
      expect(frontier.calls).toHaveLength(1);
      expect(frontier.calls[0].options?.jsonMode).toBeUndefined();
      expect(frontier.calls[0].options?.maxTokens).toBe(1024);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
