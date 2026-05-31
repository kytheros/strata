import { describe, it, expect, vi } from "vitest";

describe("gap-judge integration in gemini agent loop", () => {
  it("continues searching when gap-judge says insufficient, then stops when sufficient", async () => {
    let calls = 0;
    const fakeClient = { models: { generateContent: vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) return { candidates: [{ content: { role: "model", parts: [
        { text: "searching" }, { functionCall: { name: "search_sessions", args: { query: "x" } } }] }, finishReason: "STOP" }] };
      // model tries to answer on 2nd turn:
      return { candidates: [{ content: { role: "model", parts: [{ text: "final answer" }] }, finishReason: "STOP" }] };
    }) } };
    // gap-judge: first insufficient (force another round), then sufficient
    const verdicts = [{ sufficient: false, gaps: [{ missing: "more" }] }, { sufficient: true, gaps: [] }];
    let gj = 0;
    const gapComplete = vi.fn(async () => JSON.stringify(verdicts[Math.min(gj++, verdicts.length - 1)]));

    const { runGeminiAgentLoop } = await import("../../benchmarks/longmemeval/gemini-agent-loop.js");
    const ingested = { db: null, searchEngine: { searchSessionLevel: async () => [] }, questionId: "q",
      indexToSessionId: new Map(), sessionCount: 0, eventCount: 0 } as never;
    const question = { question_id: "q", question: "t", question_type: "single-session-user", answer: "g",
      question_date: "2026-05-31", haystack_sessions: [], haystack_dates: [] } as never;

    const result = await runGeminiAgentLoop("k", "gemini-2.5-flash", question, ingested, {
      maxIterations: 5, vertexClient: fakeClient as never,
      gapJudge: { enabled: true, complete: gapComplete },
    });
    expect(gapComplete).toHaveBeenCalled();      // gap-judge ran
    expect(result.answer).toBe("final answer");  // eventually answered
  }, 20000);

  it("does NOT invoke gap-judge when flag is off (byte-for-byte current behavior)", async () => {
    let calls = 0;
    const fakeClient = { models: { generateContent: vi.fn().mockImplementation(async () => {
      calls++;
      return { candidates: [{ content: { role: "model", parts: [{ text: "answer without gap-judge" }] }, finishReason: "STOP" }] };
    }) } };
    const gapComplete = vi.fn(async () => JSON.stringify({ sufficient: true, gaps: [] }));

    const { runGeminiAgentLoop } = await import("../../benchmarks/longmemeval/gemini-agent-loop.js");
    const ingested = { db: null, searchEngine: { searchSessionLevel: async () => [] }, questionId: "q",
      indexToSessionId: new Map(), sessionCount: 0, eventCount: 0 } as never;
    const question = { question_id: "q", question: "t", question_type: "single-session-user", answer: "g",
      question_date: "2026-05-31", haystack_sessions: [], haystack_dates: [] } as never;

    // No gapJudge option — flag off
    const result = await runGeminiAgentLoop("k", "gemini-2.5-flash", question, ingested, {
      maxIterations: 5, vertexClient: fakeClient as never,
    });
    expect(gapComplete).not.toHaveBeenCalled();  // gap-judge never called
    expect(result.answer).toBe("answer without gap-judge");
  }, 20000);
});
