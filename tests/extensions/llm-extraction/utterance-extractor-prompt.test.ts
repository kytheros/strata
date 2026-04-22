import { describe, expect, test } from "vitest";
import { extractAtomicFacts } from "../../../src/extensions/llm-extraction/utterance-extractor.js";
import type { LlmProvider } from "../../../src/extensions/llm-extraction/llm-provider.js";

function capturingProvider(response: string) {
  const captured: { prompt?: string } = {};
  const provider: LlmProvider = {
    name: "capture",
    async complete(prompt: string) {
      captured.prompt = prompt;
      return response;
    },
  };
  return { provider, captured };
}

describe("extractAtomicFacts prompt", () => {
  test("includes hedge instruction with hearsay field in schema", async () => {
    const { provider, captured } = capturingProvider(
      JSON.stringify({ facts: [] }),
    );
    await extractAtomicFacts("There's talk of bandits.", { provider });
    expect(captured.prompt).toBeDefined();
    expect(captured.prompt!.toLowerCase()).toContain("hearsay");
    expect(captured.prompt!.toLowerCase()).toContain("hedge");
  });

  test("accepts hearsay field in model output", async () => {
    const { provider } = capturingProvider(
      JSON.stringify({
        facts: [
          {
            text: "there is rumor of bandits",
            type: "semantic",
            importance: 50,
            hearsay: true,
          },
        ],
      }),
    );
    const out = await extractAtomicFacts("There's talk of bandits.", { provider });
    expect(out).toHaveLength(1);
    expect(out[0].hearsay).toBe(true);
  });

  test("defaults hearsay to undefined when absent", async () => {
    const { provider } = capturingProvider(
      JSON.stringify({
        facts: [{ text: "Goran is the blacksmith", type: "semantic" }],
      }),
    );
    const out = await extractAtomicFacts("Goran is the blacksmith.", { provider });
    expect(out[0].hearsay).toBeUndefined();
  });
});
