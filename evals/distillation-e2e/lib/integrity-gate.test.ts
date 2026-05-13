import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { applyIntegrityGate, resolveProvider } from "./integrity-gate.js";

describe("integrity-gate", () => {
  const orig = { ...process.env };
  afterEach(() => { process.env = { ...orig }; });

  test("sets STRATA_HYBRID_STRICT=1 unconditionally", () => {
    delete process.env.STRATA_HYBRID_STRICT;
    applyIntegrityGate();
    expect(process.env.STRATA_HYBRID_STRICT).toBe("1");
  });

  test("resolveProvider rejects empty STRATA_EXTRACTION_PROVIDER", () => {
    delete process.env.STRATA_EXTRACTION_PROVIDER;
    expect(() => resolveProvider()).toThrow(/STRATA_EXTRACTION_PROVIDER/);
  });

  test("resolveProvider parses ollama:gemma4:e4b", () => {
    process.env.STRATA_EXTRACTION_PROVIDER = "ollama:gemma4:e4b";
    expect(resolveProvider()).toEqual({ kind: "ollama", model: "gemma4:e4b" });
  });

  test("resolveProvider parses gemini", () => {
    process.env.STRATA_EXTRACTION_PROVIDER = "gemini";
    expect(resolveProvider()).toEqual({ kind: "gemini" });
  });

  test("resolveProvider rejects unknown kind", () => {
    process.env.STRATA_EXTRACTION_PROVIDER = "openai";
    expect(() => resolveProvider()).toThrow(/unknown provider/);
  });
});
