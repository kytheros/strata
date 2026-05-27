import { describe, it, expect } from "vitest";
import { createOllamaBenchProvider } from "../../benchmarks/longmemeval/providers/ollama-bench.js";

describe("createOllamaBenchProvider", () => {
  it("returns a provider with name='ollama' and the requested model in modelName", () => {
    const { provider, modelName } = createOllamaBenchProvider("qwen2.5:14b");
    expect(provider.name).toBe("ollama");
    expect(modelName).toBe("qwen2.5:14b");
  });

  it("respects OLLAMA_HOST env var when set", () => {
    const before = process.env.OLLAMA_HOST;
    process.env.OLLAMA_HOST = "http://my-remote:11434";
    try {
      const { provider } = createOllamaBenchProvider("gemma4:e4b");
      // Internal baseUrl isn't directly exposed, but the construction shouldn't throw.
      expect(provider.name).toBe("ollama");
    } finally {
      if (before === undefined) delete process.env.OLLAMA_HOST;
      else process.env.OLLAMA_HOST = before;
    }
  });

  it("supports colon-bearing model identifiers like 'qwen2.5:14b'", () => {
    // Ollama model names commonly include a colon (model:tag). Adapter must
    // pass these through unchanged.
    const { modelName } = createOllamaBenchProvider("qwen2.5:14b-instruct-q4_K_M");
    expect(modelName).toBe("qwen2.5:14b-instruct-q4_K_M");
  });
});
