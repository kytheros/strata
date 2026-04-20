import { describe, it, expect, vi } from "vitest";
import { extractAtomicFacts } from "../../../src/extensions/llm-extraction/utterance-extractor.js";
import type { LlmProvider } from "../../../src/extensions/llm-extraction/llm-provider.js";

function fakeProvider(response: string): LlmProvider {
  return { name: "fake", complete: vi.fn(async () => response) };
}

describe("extractAtomicFacts", () => {
  it("returns parsed facts when provider returns valid JSON", async () => {
    const provider = fakeProvider(
      JSON.stringify({ facts: [
        { text: "player is named Mike", type: "semantic", importance: 70 },
        { text: "player wants twenty spears", type: "episodic", importance: 60 },
      ] })
    );
    const facts = await extractAtomicFacts("my name is Mike and I want twenty spears", { provider });
    expect(facts).toHaveLength(2);
    expect(facts[0].text).toBe("player is named Mike");
    expect(facts[0].type).toBe("semantic");
    expect(facts[1].type).toBe("episodic");
  });

  it("returns empty array without calling provider when input is a filler word", async () => {
    const provider = fakeProvider("");
    const facts = await extractAtomicFacts("  Thanks!  ", { provider });
    expect(facts).toEqual([]);
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("caps output at maxItems", async () => {
    const provider = fakeProvider(
      JSON.stringify({ facts: Array.from({ length: 8 }, (_, i) => ({ text: `fact ${i}`, type: "semantic" })) })
    );
    const facts = await extractAtomicFacts("a long utterance", { provider, maxItems: 3 });
    expect(facts).toHaveLength(3);
  });

  it("strips code fences from provider output", async () => {
    const provider = fakeProvider("```json\n{ \"facts\": [{ \"text\": \"x\", \"type\": \"semantic\" }] }\n```");
    const facts = await extractAtomicFacts("an utterance", { provider });
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toBe("x");
  });

  it("throws when provider output is malformed JSON", async () => {
    const provider = fakeProvider("not json at all");
    await expect(extractAtomicFacts("an utterance", { provider })).rejects.toThrow();
  });

  it("propagates provider errors", async () => {
    const provider: LlmProvider = {
      name: "fake",
      complete: vi.fn(async () => { throw new Error("boom"); }),
    };
    await expect(extractAtomicFacts("an utterance", { provider })).rejects.toThrow("boom");
  });

  it("drops facts with invalid type or missing text", async () => {
    const provider = fakeProvider(
      JSON.stringify({ facts: [
        { text: "valid", type: "semantic" },
        { type: "semantic" },                        // missing text
        { text: "bad type", type: "garbage" },       // invalid type
        { text: "also valid", type: "episodic" },
      ] })
    );
    const facts = await extractAtomicFacts("a", { provider });
    expect(facts.map(f => f.text)).toEqual(["valid", "also valid"]);
  });

  it("sanitizes input before calling provider", async () => {
    const provider = fakeProvider(JSON.stringify({ facts: [] }));
    await extractAtomicFacts("my AWS key is AKIAIOSFODNN7EXAMPLE", { provider });
    const callArg = (provider.complete as any).mock.calls[0][0] as string;
    expect(callArg).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(callArg).toContain("[REDACTED");
  });

  it("passes timeoutMs through to the provider", async () => {
    const provider = fakeProvider(JSON.stringify({ facts: [] }));
    await extractAtomicFacts("a", { provider, timeoutMs: 5000 });
    const opts = (provider.complete as any).mock.calls[0][1];
    expect(opts.timeoutMs).toBe(5000);
  });
});
