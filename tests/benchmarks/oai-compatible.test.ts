import { describe, it, expect, vi } from "vitest";
import { OaiCompatibleProvider } from "../../benchmarks/longmemeval/providers/oai-compatible.js";

function mockFetch(response: any, status = 200): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => response,
    text: async () => JSON.stringify(response),
  }) as any;
}

describe("OaiCompatibleProvider", () => {
  it("posts to {baseURL}/chat/completions with bearer auth", async () => {
    const fetchFn = mockFetch({
      choices: [{ message: { content: "hello" } }],
    });
    const provider = new OaiCompatibleProvider({
      providerName: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: "sk-test-key",
      model: "meta-llama/llama-3.3-70b",
      fetchFn,
    });

    const text = await provider.complete("ping");

    expect(text).toBe("hello");
    expect(fetchFn).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer sk-test-key",
        }),
      })
    );
  });

  it("uses model + temperature + max_tokens in request body", async () => {
    const fetchFn = mockFetch({
      choices: [{ message: { content: "ok" } }],
    });
    const provider = new OaiCompatibleProvider({
      providerName: "groq",
      baseURL: "https://api.groq.com/openai/v1",
      apiKey: "sk-x",
      model: "llama-3.3-70b-versatile",
      fetchFn,
    });

    await provider.complete("hi", { maxTokens: 512, temperature: 0.5 });

    const body = JSON.parse((fetchFn as any).mock.calls[0][1].body);
    expect(body.model).toBe("llama-3.3-70b-versatile");
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(512);
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("includes systemPrompt as a system message when provided", async () => {
    const fetchFn = mockFetch({
      choices: [{ message: { content: "ok" } }],
    });
    const provider = new OaiCompatibleProvider({
      providerName: "together",
      baseURL: "https://api.together.xyz/v1",
      apiKey: "x",
      model: "Qwen/Qwen2.5-72B-Instruct-Turbo",
      fetchFn,
    });

    await provider.complete("user msg", { systemPrompt: "you are helpful" });

    const body = JSON.parse((fetchFn as any).mock.calls[0][1].body);
    expect(body.messages).toEqual([
      { role: "system", content: "you are helpful" },
      { role: "user", content: "user msg" },
    ]);
  });

  it("attaches extra headers from registry entry", async () => {
    const fetchFn = mockFetch({
      choices: [{ message: { content: "ok" } }],
    });
    const provider = new OaiCompatibleProvider({
      providerName: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: "x",
      model: "meta-llama/llama-3.3-70b",
      headers: { "HTTP-Referer": "https://strata.dev", "X-Title": "Strata" },
      fetchFn,
    });

    await provider.complete("hi");

    const call = (fetchFn as any).mock.calls[0];
    expect(call[1].headers["HTTP-Referer"]).toBe("https://strata.dev");
    expect(call[1].headers["X-Title"]).toBe("Strata");
  });

  it("throws LlmError with statusCode on 429", async () => {
    const fetchFn = mockFetch({ error: { message: "rate limited" } }, 429);
    const provider = new OaiCompatibleProvider({
      providerName: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: "x",
      model: "meta-llama/llama-3.3-70b",
      fetchFn,
    });

    await expect(provider.complete("hi")).rejects.toThrow(/rate limit/i);
  });

  it("throws LlmError with non-2xx status detail", async () => {
    const fetchFn = mockFetch({ error: { message: "boom" } }, 500);
    const provider = new OaiCompatibleProvider({
      providerName: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: "x",
      model: "meta-llama/llama-3.3-70b",
      fetchFn,
    });

    await expect(provider.complete("hi")).rejects.toThrow(/500/);
  });

  it("provider name is exposed for prompt-variant dispatch", () => {
    const provider = new OaiCompatibleProvider({
      providerName: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: "x",
      model: "meta-llama/llama-3.3-70b",
    });
    expect(provider.name).toBe("oai-compatible");
  });
});
