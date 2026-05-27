import { describe, it, expect } from "vitest";
import {
  PROVIDER_REGISTRY,
  resolveRegistryEntry,
} from "../../benchmarks/longmemeval/providers/provider-registry.js";

describe("provider-registry", () => {
  it("ships with the 8 expected entries", () => {
    expect(Object.keys(PROVIDER_REGISTRY).sort()).toEqual([
      "deepinfra",
      "fireworks",
      "groq",
      "local-vllm",
      "mistral",
      "openrouter",
      "together",
      "xai",
    ]);
  });

  it("openrouter entry has correct shape", () => {
    expect(PROVIDER_REGISTRY.openrouter).toEqual({
      baseURL: "https://openrouter.ai/api/v1",
      apiKeyEnvVar: "OPENROUTER_API_KEY",
    });
  });

  it("resolveRegistryEntry returns entry for known name", () => {
    expect(resolveRegistryEntry("groq")).toEqual({
      baseURL: "https://api.groq.com/openai/v1",
      apiKeyEnvVar: "GROQ_API_KEY",
    });
  });

  it("resolveRegistryEntry returns null for unknown name", () => {
    expect(resolveRegistryEntry("nonexistent")).toBeNull();
  });

  it("resolveRegistryEntry is case-sensitive", () => {
    expect(resolveRegistryEntry("OpenRouter")).toBeNull();
    expect(resolveRegistryEntry("openrouter")).not.toBeNull();
  });
});
