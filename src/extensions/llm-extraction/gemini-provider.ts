/** Community edition stub — returns null (no LLM provider available). */
import type { LlmProvider } from "./llm-provider.js";

export async function getCachedGeminiProvider(): Promise<LlmProvider | null> {
  return null;
}
