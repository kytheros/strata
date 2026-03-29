/**
 * Factory for creating ToolCallingProvider instances.
 *
 * Auto-detects the provider from available environment variables,
 * or creates a specific provider by name. Priority order for auto-detection:
 * 1. GEMINI_API_KEY (cheapest at $0.30/1M input)
 * 2. OPENAI_API_KEY
 * 3. ANTHROPIC_API_KEY
 */

import type { ToolCallingProvider } from "../tool-calling-provider.js";
import { LlmError } from "../../extensions/llm-extraction/llm-provider.js";
import { OpenAIToolCallingProvider } from "./openai-adapter.js";
import { AnthropicToolCallingProvider } from "./anthropic-adapter.js";
import { GeminiToolCallingProvider } from "./gemini-adapter.js";

/**
 * Create a ToolCallingProvider by name or auto-detect from environment variables.
 *
 * @param providerName - "openai", "anthropic", "gemini", "auto", or undefined (auto)
 * @param model - Optional model override (uses provider default if omitted)
 * @returns A configured ToolCallingProvider instance
 * @throws LlmError if no API key is found for the requested/detected provider
 */
export function createToolCallingProvider(
  providerName?: string,
  model?: string,
): ToolCallingProvider {
  const name = providerName?.toLowerCase();

  // Explicit provider selection
  if (name && name !== "auto") {
    switch (name) {
      case "openai": {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
          throw new LlmError(
            "OPENAI_API_KEY environment variable is not set",
            "openai",
          );
        }
        return new OpenAIToolCallingProvider(apiKey, model);
      }
      case "anthropic": {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          throw new LlmError(
            "ANTHROPIC_API_KEY environment variable is not set",
            "anthropic",
          );
        }
        return new AnthropicToolCallingProvider(apiKey, model);
      }
      case "gemini": {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
          throw new LlmError(
            "GEMINI_API_KEY environment variable is not set",
            "gemini",
          );
        }
        return new GeminiToolCallingProvider(apiKey, model);
      }
      default:
        throw new LlmError(
          `Unknown provider: "${providerName}". Supported: openai, anthropic, gemini`,
          "factory",
        );
    }
  }

  // Auto-detect by checking environment variables in priority order
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    return new GeminiToolCallingProvider(geminiKey, model);
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    return new OpenAIToolCallingProvider(openaiKey, model);
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    return new AnthropicToolCallingProvider(anthropicKey, model);
  }

  throw new LlmError(
    "No API key found. Set one of: GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY",
    "factory",
  );
}
