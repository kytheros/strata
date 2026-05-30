import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Verifies that runGeminiAgentLoop dispatches to the Vertex SDK client when
 * vertexClient is passed via options, and that the captureBuffer is still
 * populated correctly (provider-agnostic).
 */

describe("runGeminiAgentLoop — Vertex SDK branch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the injected Vertex SDK client and populates captureBuffer", async () => {
    let calls = 0;
    const fakeClient = {
      models: {
        generateContent: vi.fn().mockImplementation(async () => {
          calls++;
          if (calls === 1) {
            return {
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [
                      { text: "I'll search." },
                      { functionCall: { name: "search_sessions", args: { query: "foo" } } },
                    ],
                  },
                  finishReason: "STOP",
                },
              ],
              usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
            };
          }
          return {
            candidates: [
              { content: { role: "model", parts: [{ text: "the answer" }] }, finishReason: "STOP" },
            ],
            usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 10 },
          };
        }),
      },
    };

    const { runGeminiAgentLoop } = await import(
      "../../benchmarks/longmemeval/gemini-agent-loop.js"
    );

    const ingested = {
      db: null,
      searchEngine: { searchSessionLevel: async () => [] },
      questionId: "qt1",
      indexToSessionId: new Map(),
      sessionCount: 0,
      eventCount: 0,
    } as unknown as Parameters<typeof runGeminiAgentLoop>[3];

    const question = {
      question_id: "qt1",
      question: "test",
      question_type: "single-session-user",
      answer: "gold",
      question_date: "2026-05-28",
      haystack_sessions: [],
      haystack_dates: [],
    } as unknown as Parameters<typeof runGeminiAgentLoop>[2];

    const result = await runGeminiAgentLoop("unused", "gemini-2.5-flash", question, ingested, {
      maxIterations: 4,
      vertexClient: fakeClient as never,
    });

    expect(fakeClient.models.generateContent).toHaveBeenCalled();
    expect(result.answer).toBe("the answer");

    const toolCallPairs = result.captureBuffer.filter((p) => p.kind === "reasoning_tool_call");
    const finalAnswerPairs = result.captureBuffer.filter((p) => p.kind === "reasoning_final_answer");
    expect(toolCallPairs).toHaveLength(1);
    expect(finalAnswerPairs).toHaveLength(1);
  });

  it("retries a Vertex 429 ApiError and continues the loop", async () => {
    const apiError = Object.assign(
      new Error(
        'ApiError: {"error":{"code":429,"message":"Resource exhausted","status":"RESOURCE_EXHAUSTED"}}'
      ),
      { status: 429 }
    );

    let calls = 0;
    const fakeClient = {
      models: {
        generateContent: vi.fn().mockImplementation(async () => {
          calls++;
          if (calls === 1) throw apiError;
          if (calls === 2) throw apiError;
          // 3rd call: succeed and finish.
          return {
            candidates: [
              {
                content: { role: "model", parts: [{ text: "ok after retry" }] },
                finishReason: "STOP",
              },
            ],
          };
        }),
      },
    };

    const { runGeminiAgentLoop } = await import(
      "../../benchmarks/longmemeval/gemini-agent-loop.js"
    );

    const ingested = {
      db: null,
      searchEngine: { searchSessionLevel: async () => [] },
      questionId: "qt2",
      indexToSessionId: new Map(),
      sessionCount: 0,
      eventCount: 0,
    } as unknown as Parameters<typeof runGeminiAgentLoop>[3];

    const question = {
      question_id: "qt2",
      question: "test",
      question_type: "single-session-user",
      answer: "gold",
      question_date: "2026-05-28",
      haystack_sessions: [],
      haystack_dates: [],
    } as unknown as Parameters<typeof runGeminiAgentLoop>[2];

    // Stub console.log so we don't pollute test output with retry banners.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await runGeminiAgentLoop("unused", "gemini-2.5-flash", question, ingested, {
      maxIterations: 2,
      vertexClient: fakeClient as never,
    });

    expect(result.answer).toBe("ok after retry");
    expect(fakeClient.models.generateContent).toHaveBeenCalledTimes(3);
    logSpy.mockRestore();
  }, 60000);
});
