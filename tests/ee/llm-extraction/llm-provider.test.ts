import { describe, it, expect, vi } from "vitest";
import {
  LlmError,
  OllamaProvider,
} from "../../../src/extensions/llm-extraction/llm-provider.js";
import type {
  LlmProvider,
  CompletionOptions,
  CompletionResult,
} from "../../../src/extensions/llm-extraction/llm-provider.js";

describe("LlmError", () => {
  it("should construct with message and provider", () => {
    const err = new LlmError("timeout", "gemini");
    expect(err.message).toBe("timeout");
    expect(err.provider).toBe("gemini");
    expect(err.statusCode).toBeUndefined();
    expect(err.name).toBe("LlmError");
  });

  it("should construct with message, provider, and statusCode", () => {
    const err = new LlmError("Rate limited", "gemini", 429);
    expect(err.message).toBe("Rate limited");
    expect(err.provider).toBe("gemini");
    expect(err.statusCode).toBe(429);
  });

  it("should be an instance of Error", () => {
    const err = new LlmError("test", "test");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LlmError);
  });
});

describe("LlmProvider interface", () => {
  it("should be implementable with name and complete", () => {
    const provider: LlmProvider = {
      name: "test",
      complete: async (_prompt: string, _options?: CompletionOptions) => "result",
    };
    expect(provider.name).toBe("test");
  });
});

describe("CompletionResult type", () => {
  it("should have text and model fields", () => {
    const result: CompletionResult = {
      text: "Hello",
      model: "gemini-2.5-flash",
    };
    expect(result.text).toBe("Hello");
    expect(result.model).toBe("gemini-2.5-flash");
  });

  it("should accept optional repaired field", () => {
    const result: CompletionResult = {
      text: "Hello",
      model: "gemini-2.5-flash",
      repaired: true,
    };
    expect(result.repaired).toBe(true);
  });
});

describe("OllamaProvider", () => {
  it("should construct with defaults", () => {
    const provider = new OllamaProvider();
    expect(provider.name).toBe("ollama");
  });

  it("should construct with custom model and URL", () => {
    const provider = new OllamaProvider(
      "strata-extraction-7b",
      "http://localhost:11435"
    );
    expect(provider.name).toBe("ollama");
  });

  it("should strip trailing slash from baseUrl", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: "test output" }),
    });

    // Temporarily replace global fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const provider = new OllamaProvider(
        "llama3.2",
        "http://localhost:11434/"
      );
      await provider.complete("test");

      const url = mockFetch.mock.calls[0][0];
      expect(url).toBe("http://localhost:11434/api/generate");
      expect(url).not.toContain("//api");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should call Ollama API with correct payload", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: "Generated text" }),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const provider = new OllamaProvider("strata-extraction-7b");
      const result = await provider.complete("test prompt", {
        temperature: 0.1,
        timeoutMs: 15000,
      });

      expect(result).toBe("Generated text");
      expect(mockFetch).toHaveBeenCalledOnce();

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain("/api/generate");

      const body = JSON.parse(options.body);
      expect(body.model).toBe("strata-extraction-7b");
      expect(body.prompt).toBe("test prompt");
      expect(body.stream).toBe(false);
      expect(body.options.temperature).toBe(0.1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should throw LlmError on non-ok response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "model not found",
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const provider = new OllamaProvider("nonexistent-model");
      await expect(provider.complete("test")).rejects.toThrow(LlmError);

      try {
        await provider.complete("test");
      } catch (e) {
        expect((e as LlmError).statusCode).toBe(404);
        expect((e as LlmError).provider).toBe("ollama");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should throw LlmError when response has no content", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: "" }),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const provider = new OllamaProvider();
      await expect(provider.complete("test")).rejects.toThrow(
        "No response content from Ollama"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should handle connection refused errors", async () => {
    const mockFetch = vi.fn().mockRejectedValue(
      new TypeError("fetch failed: connection refused")
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const provider = new OllamaProvider();
      await expect(provider.complete("test")).rejects.toThrow(LlmError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should use 30s default timeout", async () => {
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
      const provider = new OllamaProvider();
      // Use a very short timeout for test speed
      await expect(
        provider.complete("test", { timeoutMs: 10 })
      ).rejects.toThrow("timed out");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("OllamaProvider maxTokens forwarding", () => {
  // Regression coverage for commit 3856bf0: before the fix, OllamaProvider
  // destructured only { temperature, timeoutMs } from CompletionOptions and
  // never forwarded maxTokens to Ollama's /api/generate. Ollama's default
  // num_predict is -1 (unlimited), which let long extraction prompts run
  // past the HTTP timeout even when the model would otherwise have produced
  // a short valid answer.

  it("forwards maxTokens as options.num_predict in the request body", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: "test response" }),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const provider = new OllamaProvider("gemma4:e4b");
      await provider.complete("test prompt", { maxTokens: 512 });

      expect(mockFetch).toHaveBeenCalledOnce();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.options).toBeDefined();
      expect(body.options.num_predict).toBe(512);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("omits num_predict when maxTokens is not set", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: "test response" }),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const provider = new OllamaProvider("gemma4:e4b");
      await provider.complete("test prompt");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.options).toBeDefined();
      expect(body.options.num_predict).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("omits num_predict when maxTokens is zero or negative", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: "test response" }),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const provider = new OllamaProvider("gemma4:e4b");
      await provider.complete("test prompt", { maxTokens: 0 });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.options.num_predict).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves temperature alongside num_predict", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: "test response" }),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const provider = new OllamaProvider("gemma4:e4b");
      await provider.complete("test prompt", { maxTokens: 1024, temperature: 0.5 });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.options.num_predict).toBe(1024);
      expect(body.options.temperature).toBe(0.5);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("OllamaProvider jsonMode forwarding", () => {
  // Regression coverage for commit 3856bf0: before the fix, jsonMode was
  // never sent to Ollama, so local Gemma 4 calls didn't use native
  // JSON-constrained sampling and returned prose-wrapped output that
  // failed downstream validation.

  it("adds top-level format:'json' when jsonMode is true", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: "{}" }),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const provider = new OllamaProvider("gemma4:e4b");
      await provider.complete("test prompt", { jsonMode: true });

      expect(mockFetch).toHaveBeenCalledOnce();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.format).toBe("json");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("omits format field when jsonMode is false", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: "{}" }),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const provider = new OllamaProvider("gemma4:e4b");
      await provider.complete("test prompt", { jsonMode: false });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.format).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("omits format field when jsonMode is not set", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: "{}" }),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const provider = new OllamaProvider("gemma4:e4b");
      await provider.complete("test prompt");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.format).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
