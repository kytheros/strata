import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Isolate the API-key lookup from the developer's ~/.strata/config.json.
// `loadGeminiApiKeyFromConfig` falls back to the config file when
// GEMINI_API_KEY is unset; on dev machines that file usually has a real
// key, which makes the "no key set" assertions in this suite leak from
// the host environment. This mock makes the lookup env-only.
vi.mock("../../../src/extensions/embeddings/gemini-embedder.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/extensions/embeddings/gemini-embedder.js")
  >("../../../src/extensions/embeddings/gemini-embedder.js");
  return {
    ...actual,
    loadGeminiApiKeyFromConfig: (): string | null =>
      process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.length > 0
        ? process.env.GEMINI_API_KEY
        : null,
  };
});

import {
  GeminiProvider,
  getCachedGeminiProvider,
  resetGeminiProviderCache,
} from "../../../src/extensions/llm-extraction/gemini-provider.js";
import { LlmError } from "../../../src/extensions/llm-extraction/llm-provider.js";

describe("GeminiProvider", () => {
  it("should construct with API key and default model", () => {
    const provider = new GeminiProvider({ apiKey: "test-key" });
    expect(provider.name).toBe("gemini");
  });

  it("should call Gemini API with correct payload", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          { content: { parts: [{ text: "Hello world" }] } },
        ],
      }),
    });

    const provider = new GeminiProvider({
      apiKey: "test-key",
      model: "gemini-2.5-flash",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await provider.complete("test prompt", {
      maxTokens: 100,
      temperature: 0.5,
      timeoutMs: 5000,
    });

    expect(result).toBe("Hello world");
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(url).not.toContain("key="); // API key must be in header, not URL
    expect(url).toContain("gemini-2.5-flash");
    expect(options.headers["x-goog-api-key"]).toBe("test-key");

    const body = JSON.parse(options.body);
    expect(body.contents[0].parts[0].text).toBe("test prompt");
    expect(body.generationConfig.temperature).toBe(0.5);
    expect(body.generationConfig.maxOutputTokens).toBe(100);
  });

  it("should throw LlmError on non-ok response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "Rate limited",
    });

    const provider = new GeminiProvider({
      apiKey: "test-key",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(provider.complete("test")).rejects.toThrow(LlmError);
    try {
      await provider.complete("test");
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError);
      expect((e as LlmError).statusCode).toBe(429);
    }
  });

  it("should throw LlmError on API error in response body", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        error: { message: "Invalid API key", code: 401 },
      }),
    });

    const provider = new GeminiProvider({
      apiKey: "bad-key",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(provider.complete("test")).rejects.toThrow(LlmError);
  });

  it("should throw LlmError when response has no text content", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [] } }] }),
    });

    const provider = new GeminiProvider({
      apiKey: "test-key",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(provider.complete("test")).rejects.toThrow(
      "No text content in Gemini response"
    );
  });

  it("should handle timeout via AbortController", async () => {
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

    const provider = new GeminiProvider({
      apiKey: "test-key",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(
      provider.complete("test", { timeoutMs: 10 })
    ).rejects.toThrow("timed out");
  });

  it("should use default model gemini-2.5-flash", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
      }),
    });

    const provider = new GeminiProvider({
      apiKey: "test-key",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await provider.complete("test");
    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain("gemini-2.5-flash");
  });
});

describe("getCachedGeminiProvider", () => {
  beforeEach(() => {
    resetGeminiProviderCache();
  });

  afterEach(() => {
    resetGeminiProviderCache();
    vi.unstubAllEnvs();
  });

  it("should return null when GEMINI_API_KEY is not set", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const provider = await getCachedGeminiProvider();
    expect(provider).toBeNull();
  });

  it("should return a provider when GEMINI_API_KEY is set", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key-123");
    const provider = await getCachedGeminiProvider();
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("gemini");
  });

  it("should cache the provider on subsequent calls", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key-123");
    const first = await getCachedGeminiProvider();
    const second = await getCachedGeminiProvider();
    expect(first).toBe(second);
  });

  it("should cache null result when no key is set", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const first = await getCachedGeminiProvider();
    expect(first).toBeNull();
    // Even if we later set the key, the cached null is returned
    vi.stubEnv("GEMINI_API_KEY", "new-key");
    const second = await getCachedGeminiProvider();
    expect(second).toBeNull();
  });

  it("should return a fresh provider after resetGeminiProviderCache", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const first = await getCachedGeminiProvider();
    expect(first).toBeNull();

    resetGeminiProviderCache();
    vi.stubEnv("GEMINI_API_KEY", "new-key");
    const second = await getCachedGeminiProvider();
    expect(second).not.toBeNull();
  });
});
