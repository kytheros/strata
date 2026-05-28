import { describe, it, expect, vi, afterEach } from "vitest";
import { VertexGeminiProvider } from "../../../src/extensions/llm-extraction/vertex-gemini-provider.js";

describe("VertexGeminiProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs with projectId + location + model", () => {
    const provider = new VertexGeminiProvider({
      projectId: "gen-lang-client-0234191064",
      location: "us-central1",
      model: "gemini-2.5-flash",
      genaiClient: { models: { generateContent: vi.fn() } } as never,
    });
    expect(provider.name).toBe("vertex-gemini");
  });

  it("defaults location to us-central1", () => {
    const provider = new VertexGeminiProvider({
      projectId: "gen-lang-client-0234191064",
      model: "gemini-2.5-flash",
      genaiClient: { models: { generateContent: vi.fn() } } as never,
    });
    expect(provider.getConfig().location).toBe("us-central1");
  });

  it("throws clearly when projectId is missing", () => {
    expect(() => new VertexGeminiProvider({
      projectId: "",
      model: "gemini-2.5-flash",
    })).toThrow(/VERTEX_PROJECT_ID/);
  });

  it("returns text from a mocked SDK response (top-level .text)", async () => {
    const provider = new VertexGeminiProvider({
      projectId: "gen-lang-client-0234191064",
      model: "gemini-2.5-flash",
      genaiClient: {
        models: {
          generateContent: vi.fn().mockResolvedValue({
            text: "the answer",
            candidates: [
              {
                content: { parts: [{ text: "the answer" }] },
                finishReason: "STOP",
              },
            ],
          }),
        },
      } as never,
    });

    const result = await provider.complete("what is 2+2?");
    expect(result).toBe("the answer");
  });

  it("falls back to walking candidate parts when top-level .text is absent", async () => {
    const provider = new VertexGeminiProvider({
      projectId: "gen-lang-client-0234191064",
      model: "gemini-2.5-flash",
      genaiClient: {
        models: {
          generateContent: vi.fn().mockResolvedValue({
            candidates: [
              {
                content: { parts: [{ text: "part-a " }, { text: "part-b" }] },
                finishReason: "STOP",
              },
            ],
          }),
        },
      } as never,
    });

    const result = await provider.complete("x");
    expect(result).toBe("part-a part-b");
  });

  it("surfaces 429 as LlmError with statusCode=429", async () => {
    const sdkError = Object.assign(new Error("Quota exceeded"), { status: 429 });
    const provider = new VertexGeminiProvider({
      projectId: "gen-lang-client-0234191064",
      model: "gemini-2.5-flash",
      genaiClient: {
        models: {
          generateContent: vi.fn().mockRejectedValue(sdkError),
        },
      } as never,
    });

    await expect(provider.complete("x")).rejects.toMatchObject({
      name: "LlmError",
      statusCode: 429,
      provider: "vertex-gemini",
    });
  });

  it("throws LlmError with finishReason context when no text is returned", async () => {
    const provider = new VertexGeminiProvider({
      projectId: "gen-lang-client-0234191064",
      model: "gemini-2.5-flash",
      genaiClient: {
        models: {
          generateContent: vi.fn().mockResolvedValue({
            candidates: [{ finishReason: "SAFETY", content: { parts: [] } }],
          }),
        },
      } as never,
    });

    await expect(provider.complete("x")).rejects.toMatchObject({
      name: "LlmError",
      provider: "vertex-gemini",
      statusCode: 400,
    });
  });
});
