import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Capture-buffer population test for the Gemini agent-loop variant.
 * Mocks global fetch to drive a two-turn loop: functionCall → final text.
 * Spec: specs/2026-05-28-reasoning-trace-capture-design.md (Task 5)
 */

describe("runGeminiAgentLoop captureBuffer population", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("pushes reasoning_tool_call + reasoning_final_answer pairs", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        // Turn 1: model emits text reasoning + a functionCall
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [
                    { text: "I'll search for this." },
                    {
                      functionCall: {
                        name: "search_sessions",
                        args: { query: "foo" },
                      },
                    },
                  ],
                },
                finishReason: "STOP",
              },
            ],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      // Turn 2: pure-text final answer
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: { role: "model", parts: [{ text: "the answer" }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 10 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const { runGeminiAgentLoop } = await import("../../benchmarks/longmemeval/gemini-agent-loop.js");

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
      question: "test question",
      question_type: "single-session-user",
      answer: "gold",
      question_date: "2026-05-28",
      haystack_sessions: [],
      haystack_dates: [],
    } as unknown as Parameters<typeof runGeminiAgentLoop>[2];

    const result = await runGeminiAgentLoop(
      "gem-test",
      "gemini-2.5-flash",
      question,
      ingested,
      { maxIterations: 4 }
    );

    const toolCallPairs = result.captureBuffer.filter((p) => p.kind === "reasoning_tool_call");
    const finalAnswerPairs = result.captureBuffer.filter((p) => p.kind === "reasoning_final_answer");

    expect(toolCallPairs).toHaveLength(1);
    expect(finalAnswerPairs).toHaveLength(1);

    const tcp = toolCallPairs[0];
    if (tcp.kind === "reasoning_tool_call") {
      expect(tcp.toolCall.name).toBe("search_sessions");
      expect(tcp.toolCall.args).toEqual({ query: "foo" });
      expect(tcp.reasoning).toContain("search");
    }

    const fap = finalAnswerPairs[0];
    if (fap.kind === "reasoning_final_answer") {
      expect(fap.answer).toBe("the answer");
    }
  });

  it("pushes a reasoning_final_answer when max_iterations is hit", async () => {
    // Every call returns a functionCall → loop hits max → forced final answer
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      // The forced-final call still has tools attached (Gemini variant keeps tools),
      // so distinguish by call count: after maxIterations (2) tool-call calls + 1 final
      if (callCount > 2) {
        return new Response(
          JSON.stringify({
            candidates: [
              { content: { role: "model", parts: [{ text: "forced final" }] }, finishReason: "STOP" },
            ],
            usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  { text: "still searching" },
                  { functionCall: { name: "search_sessions", args: { query: "q" } } },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const { runGeminiAgentLoop } = await import("../../benchmarks/longmemeval/gemini-agent-loop.js");

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
      question: "loops forever",
      question_type: "single-session-user",
      answer: "gold",
      question_date: "2026-05-28",
      haystack_sessions: [],
      haystack_dates: [],
    } as unknown as Parameters<typeof runGeminiAgentLoop>[2];

    const result = await runGeminiAgentLoop(
      "gem-test",
      "gemini-2.5-flash",
      question,
      ingested,
      { maxIterations: 2 }
    );

    const finalAnswerPairs = result.captureBuffer.filter((p) => p.kind === "reasoning_final_answer");
    expect(finalAnswerPairs).toHaveLength(1);
    if (finalAnswerPairs[0].kind === "reasoning_final_answer") {
      expect(finalAnswerPairs[0].answer).toBe("forced final");
    }

    const toolCallPairs = result.captureBuffer.filter((p) => p.kind === "reasoning_tool_call");
    expect(toolCallPairs.length).toBe(2);
  });
});
