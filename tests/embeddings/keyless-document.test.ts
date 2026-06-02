// strata/tests/embeddings/keyless-document.test.ts
import { describe, it, expect } from "vitest";
import { shouldEmbedDocuments } from "../../src/extensions/embeddings/active-model.js";

describe("keyless document degradation", () => {
  it("does not attempt document embeddings when provider is local and no Gemini key", () => {
    expect(shouldEmbedDocuments({ provider: "local" } as any, /* hasGeminiCreds */ false)).toBe(false);
  });
  it("still embeds documents when Gemini creds exist (any active text provider)", () => {
    expect(shouldEmbedDocuments({ provider: "local" } as any, true)).toBe(true);
  });
});
