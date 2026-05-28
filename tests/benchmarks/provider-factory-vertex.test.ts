import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("provider-factory: vertex: prefix", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.VERTEX_PROJECT_ID;
    delete process.env.VERTEX_LOCATION;
    delete process.env.LONGMEMEVAL_ANSWER_MODEL;
    delete process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("resolves vertex:gemini-2.5-flash to VertexGeminiProvider", async () => {
    process.env.VERTEX_PROJECT_ID = "gen-lang-client-0234191064";
    process.env.LONGMEMEVAL_ANSWER_MODEL = "vertex:gemini-2.5-flash";

    const { createAnswerProvider } = await import(
      "../../benchmarks/longmemeval/providers/provider-factory.js"
    );
    const { provider, modelName } = createAnswerProvider();

    expect(provider.name).toBe("vertex-gemini");
    expect(modelName).toBe("vertex:gemini-2.5-flash");
  });

  it("throws a clear error when VERTEX_PROJECT_ID is unset", async () => {
    process.env.LONGMEMEVAL_ANSWER_MODEL = "vertex:gemini-2.5-flash";

    const { createAnswerProvider } = await import(
      "../../benchmarks/longmemeval/providers/provider-factory.js"
    );
    expect(() => createAnswerProvider()).toThrow(/VERTEX_PROJECT_ID/);
  });

  it("AI Studio path (bare 'gemini-2.5-flash') is unchanged", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.LONGMEMEVAL_ANSWER_MODEL = "gemini-2.5-flash";

    const { createAnswerProvider } = await import(
      "../../benchmarks/longmemeval/providers/provider-factory.js"
    );
    const { provider } = createAnswerProvider();
    expect(provider.name).toBe("gemini");
  });
});
