/**
 * Provider factory tests.
 *
 * Verifies environment variable detection, provider auto-selection priority,
 * explicit provider selection, and error handling when keys are missing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createToolCallingProvider } from "../../src/reasoning/providers/factory.js";

describe("createToolCallingProvider", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    savedEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    savedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  // -----------------------------------------------------------------------
  // Error cases
  // -----------------------------------------------------------------------

  it("throws when no API key is available", () => {
    expect(() => createToolCallingProvider()).toThrow(
      "No API key found",
    );
  });

  it("throws when explicit provider has no key", () => {
    expect(() => createToolCallingProvider("openai")).toThrow(
      "OPENAI_API_KEY environment variable is not set",
    );
  });

  // -----------------------------------------------------------------------
  // Auto-detection — single key set
  // -----------------------------------------------------------------------

  it("auto-detects Gemini when GEMINI_API_KEY is set", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    const provider = createToolCallingProvider();
    expect(provider.name).toBe("gemini");
  });

  it("auto-detects OpenAI when only OPENAI_API_KEY is set", () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    const provider = createToolCallingProvider();
    expect(provider.name).toBe("openai");
  });

  it("auto-detects Anthropic when only ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    const provider = createToolCallingProvider();
    expect(provider.name).toBe("anthropic");
  });

  // -----------------------------------------------------------------------
  // Auto-detection — priority order
  // -----------------------------------------------------------------------

  it("prefers Gemini over OpenAI in auto mode when both keys are set", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.OPENAI_API_KEY = "test-openai-key";
    const provider = createToolCallingProvider();
    expect(provider.name).toBe("gemini");
  });

  // -----------------------------------------------------------------------
  // Explicit provider selection
  // -----------------------------------------------------------------------

  it("selects explicit provider when specified", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.OPENAI_API_KEY = "test-openai-key";
    const provider = createToolCallingProvider("openai");
    expect(provider.name).toBe("openai");
  });

  // -----------------------------------------------------------------------
  // Model override
  // -----------------------------------------------------------------------

  it("model override does not throw", () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    const provider = createToolCallingProvider("openai", "gpt-4o-mini");
    expect(provider.name).toBe("openai");
  });
});
