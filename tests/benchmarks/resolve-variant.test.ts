import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { _resolveVariantForTest } from "../../benchmarks/longmemeval/answer.js";

describe("resolveVariant — extended for ollama + oai-compatible", () => {
  const originalEnv = process.env.LONGMEMEVAL_COT_VARIANT;

  beforeEach(() => {
    delete process.env.LONGMEMEVAL_COT_VARIANT;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.LONGMEMEVAL_COT_VARIANT;
    else process.env.LONGMEMEVAL_COT_VARIANT = originalEnv;
  });

  it("ollama defaults to chain-of-note-gemini", () => {
    expect(_resolveVariantForTest("chain-of-note", "ollama")).toBe("chain-of-note-gemini");
  });

  it("oai-compatible defaults to chain-of-note-openai", () => {
    expect(_resolveVariantForTest("chain-of-note", "oai-compatible")).toBe(
      "chain-of-note-openai"
    );
  });

  it("LONGMEMEVAL_COT_VARIANT=claude overrides for ollama", () => {
    process.env.LONGMEMEVAL_COT_VARIANT = "claude";
    expect(_resolveVariantForTest("chain-of-note", "ollama")).toBe("chain-of-note-anthropic");
  });

  it("LONGMEMEVAL_COT_VARIANT=openai overrides for ollama", () => {
    process.env.LONGMEMEVAL_COT_VARIANT = "openai";
    expect(_resolveVariantForTest("chain-of-note", "ollama")).toBe("chain-of-note-openai");
  });

  it("LONGMEMEVAL_COT_VARIANT=gemini overrides for oai-compatible", () => {
    process.env.LONGMEMEVAL_COT_VARIANT = "gemini";
    expect(_resolveVariantForTest("chain-of-note", "oai-compatible")).toBe(
      "chain-of-note-gemini"
    );
  });

  it("LONGMEMEVAL_COT_VARIANT=none returns generic chain-of-note", () => {
    process.env.LONGMEMEVAL_COT_VARIANT = "none";
    expect(_resolveVariantForTest("chain-of-note", "ollama")).toBe("chain-of-note");
  });

  it("existing native providers still resolve correctly (back-compat)", () => {
    expect(_resolveVariantForTest("chain-of-note", "anthropic")).toBe("chain-of-note-anthropic");
    expect(_resolveVariantForTest("chain-of-note", "openai")).toBe("chain-of-note-openai");
    expect(_resolveVariantForTest("chain-of-note", "gemini")).toBe("chain-of-note-gemini");
  });

  it("non-chain-of-note variants are passed through unchanged", () => {
    expect(_resolveVariantForTest("original", "ollama")).toBe("original");
    expect(_resolveVariantForTest("enhanced", "oai-compatible")).toBe("enhanced");
  });
});
