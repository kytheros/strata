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
});
