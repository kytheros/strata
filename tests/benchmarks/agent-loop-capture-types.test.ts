import { describe, it, expect } from "vitest";
import type { CapturePair, AgentLoopResult } from "../../benchmarks/longmemeval/agent-loop.js";
import type { GeminiAgentLoopResult } from "../../benchmarks/longmemeval/gemini-agent-loop.js";

describe("CapturePair type + captureBuffer on AgentLoopResult variants", () => {
  it("CapturePair admits reasoning_tool_call shape", () => {
    const pair: CapturePair = {
      kind: "reasoning_tool_call",
      messages: [{ role: "user", content: "test" }],
      toolCall: { name: "search_sessions", args: { query: "foo" } },
      reasoning: "I should search.",
    };
    expect(pair.kind).toBe("reasoning_tool_call");
    if (pair.kind === "reasoning_tool_call") {
      expect(pair.toolCall.name).toBe("search_sessions");
    }
  });

  it("CapturePair admits reasoning_final_answer shape with null reasoning", () => {
    const pair: CapturePair = {
      kind: "reasoning_final_answer",
      messages: [{ role: "user", content: "test" }],
      answer: "the answer",
      reasoning: null,
    };
    expect(pair.kind).toBe("reasoning_final_answer");
    if (pair.kind === "reasoning_final_answer") {
      expect(pair.answer).toBe("the answer");
      expect(pair.reasoning).toBeNull();
    }
  });

  it("AgentLoopResult requires captureBuffer", () => {
    const result: AgentLoopResult = {
      answer: "x",
      latencyMs: 100,
      iterations: 2,
      toolCallLog: [],
      tokenUsage: { promptTokens: 100, completionTokens: 50 },
      captureBuffer: [],
    };
    expect(result.captureBuffer).toEqual([]);
  });

  it("GeminiAgentLoopResult requires captureBuffer", () => {
    const result: GeminiAgentLoopResult = {
      answer: "x",
      latencyMs: 100,
      iterations: 2,
      toolCallLog: [],
      captureBuffer: [],
    };
    expect(result.captureBuffer).toEqual([]);
  });
});
