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

import { normalizeKey } from "../../../src/extensions/llm-extraction/utterance-extractor.js";

describe("normalizeKey (Spec 2026-04-28)", () => {
  it("collapses casing and articles", () => {
    expect(normalizeKey("Current Horse")).toBe("current_hors");
    expect(normalizeKey("the current horse")).toBe("current_hors");
    expect(normalizeKey("CURRENT HORSE")).toBe("current_hors");
  });

  it("strips punctuation", () => {
    expect(normalizeKey("current's horse!")).toBe("current_hors");
  });

  it("light-stems plurals and gerunds", () => {
    expect(normalizeKey("rides")).toBe("ride");
    expect(normalizeKey("riding horses")).toBe("rid_hors");
    expect(normalizeKey("ordered shields")).toBe("order_shield");
    expect(normalizeKey("ordering shields")).toBe("order_shield");
    expect(normalizeKey("armies")).toBe("army");
  });

  it("does not collapse short stems aggressively", () => {
    expect(normalizeKey("is")).toBe("");
    expect(normalizeKey("ride")).toBe("ride");
    expect(normalizeKey("rid")).toBe("rid");
  });

  it("returns empty string for empty / stopword-only input", () => {
    expect(normalizeKey("")).toBe("");
    expect(normalizeKey("the of for")).toBe("");
  });

  it("strips non-ASCII letters via \w regex (best-effort)", () => {
    expect(normalizeKey("café")).toBe("caf");
  });
});

describe("extractAtomicFacts — subject/predicate (Spec 2026-04-28)", () => {
  it("parses subject and predicate when present", async () => {
    const provider = fakeProvider(JSON.stringify({
      facts: [
        { text: "player's current horse is Shadowfax", type: "semantic", subject: "player", predicate: "current horse" },
      ],
    }));
    const facts = await extractAtomicFacts("My new horse is Shadowfax", { provider });
    expect(facts.length).toBe(1);
    expect(facts[0].subject).toBe("player");
    expect(facts[0].predicate).toBe("current horse");
  });

  it("leaves subject/predicate undefined when LLM omits them", async () => {
    const provider = fakeProvider(JSON.stringify({
      facts: [{ text: "a fact without keys", type: "semantic" }],
    }));
    const facts = await extractAtomicFacts("a line", { provider });
    expect(facts[0].subject).toBeUndefined();
    expect(facts[0].predicate).toBeUndefined();
  });

  it("ignores non-string subject/predicate fields", async () => {
    const provider = fakeProvider(JSON.stringify({
      facts: [{ text: "a fact", type: "semantic", subject: 42, predicate: { obj: true } }],
    }));
    const facts = await extractAtomicFacts("a line", { provider });
    expect(facts[0].subject).toBeUndefined();
    expect(facts[0].predicate).toBeUndefined();
  });

  it("buildPrompt() includes the compound-update guidance and examples", async () => {
    let captured = "";
    const recorder: LlmProvider = {
      name: "recorder",
      complete: async (prompt: string) => { captured = prompt; return JSON.stringify({ facts: [] }); },
    };
    await extractAtomicFacts("anything", { provider: recorder });
    expect(captured).toContain("Compound updates:");
    expect(captured).toContain("Silvermist died last winter. My new horse is Shadowfax");
    expect(captured).toContain("eight shields");
  });
});
