import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createAnswerProvider,
  createJudgeProvider,
} from "../../benchmarks/longmemeval/providers/provider-factory.js";

describe("provider-factory — prefix dispatch", () => {
  const originalEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "LONGMEMEVAL_ANSWER_MODEL",
    "LONGMEMEVAL_JUDGE_MODEL",
    "LONGMEMEVAL_OAI_COMPAT_BASE_URL",
    "LONGMEMEVAL_OAI_COMPAT_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
    "TOGETHER_API_KEY",
    "GROQ_API_KEY",
  ];

  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("native gemini model uses GeminiProvider", () => {
    process.env.GEMINI_API_KEY = "g-test";
    process.env.LONGMEMEVAL_ANSWER_MODEL = "gemini-2.5-flash";
    const { provider, modelName } = createAnswerProvider();
    expect(provider.name).toBe("gemini");
    expect(modelName).toBe("gemini-2.5-flash");
  });

  it("native gpt-4o uses OpenAIProvider", () => {
    process.env.OPENAI_API_KEY = "o-test";
    process.env.LONGMEMEVAL_ANSWER_MODEL = "gpt-4o";
    const { provider } = createAnswerProvider();
    expect(provider.name).toBe("openai");
  });

  it("native claude-sonnet-4-6 uses AnthropicProvider", () => {
    process.env.ANTHROPIC_API_KEY = "a-test";
    process.env.LONGMEMEVAL_ANSWER_MODEL = "claude-sonnet-4-6";
    const { provider } = createAnswerProvider();
    expect(provider.name).toBe("anthropic");
  });

  it("ollama: prefix dispatches to OllamaProvider (no API key needed)", () => {
    process.env.LONGMEMEVAL_ANSWER_MODEL = "ollama:qwen2.5:14b";
    const { provider, modelName } = createAnswerProvider();
    expect(provider.name).toBe("ollama");
    expect(modelName).toBe("qwen2.5:14b");
  });

  it("openrouter: prefix dispatches to OaiCompatibleProvider with registry baseURL", () => {
    process.env.OPENROUTER_API_KEY = "or-test";
    process.env.LONGMEMEVAL_ANSWER_MODEL = "openrouter:meta-llama/llama-3.3-70b";
    const { provider, modelName } = createAnswerProvider();
    expect(provider.name).toBe("oai-compatible");
    expect(modelName).toBe("openrouter:meta-llama/llama-3.3-70b");
  });

  it("together: prefix preserves the slash-bearing model identifier", () => {
    process.env.TOGETHER_API_KEY = "t-test";
    process.env.LONGMEMEVAL_ANSWER_MODEL = "together:Qwen/Qwen2.5-72B-Instruct-Turbo";
    const { provider } = createAnswerProvider();
    expect(provider.name).toBe("oai-compatible");
  });

  it("custom: prefix with env vars dispatches to OaiCompatibleProvider", () => {
    process.env.LONGMEMEVAL_OAI_COMPAT_BASE_URL = "https://my-endpoint/v1";
    process.env.LONGMEMEVAL_OAI_COMPAT_API_KEY = "custom-key";
    process.env.LONGMEMEVAL_ANSWER_MODEL = "custom:my-private-model";
    const { provider, modelName } = createAnswerProvider();
    expect(provider.name).toBe("oai-compatible");
    expect(modelName).toBe("custom:my-private-model");
  });

  it("custom: prefix without env vars throws", () => {
    process.env.LONGMEMEVAL_ANSWER_MODEL = "custom:my-model";
    expect(() => createAnswerProvider()).toThrow(/LONGMEMEVAL_OAI_COMPAT_BASE_URL/);
  });

  it("registered prefix without API key throws", () => {
    process.env.LONGMEMEVAL_ANSWER_MODEL = "openrouter:meta-llama/llama-3.3-70b";
    expect(() => createAnswerProvider()).toThrow(/OPENROUTER_API_KEY/);
  });

  it("unknown prefix that isn't in registry and isn't a native model throws", () => {
    process.env.LONGMEMEVAL_ANSWER_MODEL = "fakeprovider:fake-model";
    expect(() => createAnswerProvider()).toThrow();
  });

  it("createJudgeProvider supports the same prefix dispatch", () => {
    process.env.LONGMEMEVAL_JUDGE_MODEL = "ollama:qwen2.5:14b";
    const { provider } = createJudgeProvider();
    expect(provider.name).toBe("ollama");
  });
});
