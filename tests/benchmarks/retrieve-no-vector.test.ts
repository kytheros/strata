import { describe, it, expect, vi } from "vitest";
import { retrieveQuestion } from "../../benchmarks/longmemeval/retrieve.js";

describe("retrieveQuestion — noVector option", () => {
  it("passes skipVector=true to searchEngine.searchAsync when noVector=true", async () => {
    const searchAsyncMock = vi.fn().mockResolvedValue([]);
    const searchTurnsMock = vi.fn().mockResolvedValue([]);
    const ingested = {
      searchEngine: {
        searchAsync: searchAsyncMock,
        searchTurns: searchTurnsMock,
        searchSessionLevel: vi.fn(),
      },
    } as any;
    const question = {
      question_id: "Q1",
      question: "what is x?",
      question_type: "single-session-user",
      answer: "y",
      answer_session_ids: ["s1"],
      haystack_session_ids: ["s1", "s2"],
      haystack_sessions: [],
    } as any;

    await retrieveQuestion(question, ingested, undefined, { noVector: true });

    // First searchAsync call should pass skipVector: true
    expect(searchAsyncMock).toHaveBeenCalled();
    const firstCallOpts = searchAsyncMock.mock.calls[0][1];
    expect(firstCallOpts).toEqual(
      expect.objectContaining({ skipVector: true })
    );
  });

  it("defaults skipVector to false when noVector is omitted", async () => {
    const searchAsyncMock = vi.fn().mockResolvedValue([]);
    const searchTurnsMock = vi.fn().mockResolvedValue([]);
    const ingested = {
      searchEngine: {
        searchAsync: searchAsyncMock,
        searchTurns: searchTurnsMock,
      },
    } as any;
    const question = {
      question_id: "Q1",
      question: "what is x?",
      question_type: "single-session-user",
      answer: "y",
      answer_session_ids: ["s1"],
      haystack_session_ids: ["s1", "s2"],
      haystack_sessions: [],
    } as any;

    await retrieveQuestion(question, ingested);

    const firstCallOpts = searchAsyncMock.mock.calls[0][1];
    expect(firstCallOpts).toEqual(
      expect.objectContaining({ skipVector: false })
    );
  });
});
