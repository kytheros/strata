import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Capture-buffer population test for the OpenAI agent-loop variant.
 * Mocks global fetch to drive a two-turn loop: tool_call → final_answer.
 * Spec: specs/2026-05-28-reasoning-trace-capture-design.md (Task 4)
 */

describe("runAgentLoop captureBuffer population", () => {
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
        // Turn 1: model emits reasoning text + a tool_call
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Let me search for this.",
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "search_sessions",
                        arguments: '{"query":"foo"}',
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 20 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      // Turn 2: final text answer
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: "the answer" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 200, completion_tokens: 10 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const { runAgentLoop } = await import("../../benchmarks/longmemeval/agent-loop.js");

    const ingested = {
      db: null,
      searchEngine: { searchSessionLevel: async () => [] },
      questionId: "qt1",
      indexToSessionId: new Map(),
      sessionCount: 0,
      eventCount: 0,
    } as unknown as Parameters<typeof runAgentLoop>[3];

    const question = {
      question_id: "qt1",
      question: "test question",
      question_type: "single-session-user",
      answer: "gold",
      question_date: "2026-05-28",
      haystack_sessions: [],
      haystack_dates: [],
    } as unknown as Parameters<typeof runAgentLoop>[2];

    const result = await runAgentLoop("sk-test", "gpt-4o-2024-08-06", question, ingested, {
      maxIterations: 4,
    });

    const toolCallPairs = result.captureBuffer.filter((p) => p.kind === "reasoning_tool_call");
    const finalAnswerPairs = result.captureBuffer.filter((p) => p.kind === "reasoning_final_answer");

    expect(toolCallPairs).toHaveLength(1);
    expect(finalAnswerPairs).toHaveLength(1);

    const tcp = toolCallPairs[0];
    if (tcp.kind === "reasoning_tool_call") {
      expect(tcp.toolCall.name).toBe("search_sessions");
      expect(tcp.toolCall.args).toEqual({ query: "foo" });
      expect(tcp.reasoning).toBe("Let me search for this.");
      // Messages snapshot at decision point should NOT yet contain the assistant turn.
      const lastRole = tcp.messages[tcp.messages.length - 1].role;
      expect(["system", "user"]).toContain(lastRole);
    }

    const fap = finalAnswerPairs[0];
    if (fap.kind === "reasoning_final_answer") {
      expect(fap.answer).toBe("the answer");
    }
  });

  it("pushes a reasoning_final_answer when max_iterations is hit", async () => {
    // Every call returns a tool_call → loop hits max_iterations → forced final answer.
    globalThis.fetch = vi.fn(async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body) as { tools?: unknown[] };
      // Final forced-answer call passes no tools array — return plain text.
      if (body.tools === undefined) {
        return new Response(
          JSON.stringify({
            choices: [
              { message: { role: "assistant", content: "forced final" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 50, completion_tokens: 5 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "still searching",
                tool_calls: [
                  {
                    id: "x",
                    type: "function",
                    function: { name: "search_sessions", arguments: '{"query":"q"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const { runAgentLoop } = await import("../../benchmarks/longmemeval/agent-loop.js");

    const ingested = {
      db: null,
      searchEngine: { searchSessionLevel: async () => [] },
      questionId: "qt2",
      indexToSessionId: new Map(),
      sessionCount: 0,
      eventCount: 0,
    } as unknown as Parameters<typeof runAgentLoop>[3];

    const question = {
      question_id: "qt2",
      question: "loops forever",
      question_type: "single-session-user",
      answer: "gold",
      question_date: "2026-05-28",
      haystack_sessions: [],
      haystack_dates: [],
    } as unknown as Parameters<typeof runAgentLoop>[2];

    const result = await runAgentLoop("sk-test", "gpt-4o-2024-08-06", question, ingested, {
      maxIterations: 2,
    });

    const finalAnswerPairs = result.captureBuffer.filter((p) => p.kind === "reasoning_final_answer");
    expect(finalAnswerPairs).toHaveLength(1);
    if (finalAnswerPairs[0].kind === "reasoning_final_answer") {
      expect(finalAnswerPairs[0].answer).toBe("forced final");
    }

    // And one tool_call pair per iteration that emitted tool_calls (= maxIterations = 2)
    const toolCallPairs = result.captureBuffer.filter((p) => p.kind === "reasoning_tool_call");
    expect(toolCallPairs.length).toBe(2);
  });
});
