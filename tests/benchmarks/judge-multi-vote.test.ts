import { describe, it, expect, vi } from "vitest";
import { judgeAnswer } from "../../benchmarks/longmemeval/judge.js";
import type { LlmProvider } from "../../src/extensions/llm-extraction/llm-provider.js";

function makeProvider(responses: string[]): LlmProvider {
  let i = 0;
  return {
    name: "openai",
    complete: vi.fn(async () => responses[i++ % responses.length]),
  };
}

describe("judgeAnswer — multi-vote with majority", () => {
  it("returns single verdict when votes=1 (back-compat)", async () => {
    const provider = makeProvider(["yes"]);
    const result = await judgeAnswer(
      provider, "single-session-user", "q1", "question?", "gold", "predicted"
    );
    expect(result.verdict).toBe("CORRECT");
    expect(result.voteBreakdown).toBeUndefined();
  });

  it("returns CORRECT when 2 of 3 votes say yes", async () => {
    const provider = makeProvider(["yes", "no", "yes"]);
    const result = await judgeAnswer(
      provider, "single-session-user", "q1", "question?", "gold", "predicted",
      { votes: 3 }
    );
    expect(result.verdict).toBe("CORRECT");
    expect(result.voteBreakdown).toMatchObject({ correct: 2, incorrect: 1 });
    expect(result.voteBreakdown?.rawResponses).toHaveLength(3);
  });

  it("returns INCORRECT when 3 of 5 votes say no", async () => {
    const provider = makeProvider(["yes", "no", "no", "yes", "no"]);
    const result = await judgeAnswer(
      provider, "single-session-user", "q1", "question?", "gold", "predicted",
      { votes: 5 }
    );
    expect(result.verdict).toBe("INCORRECT");
    expect(result.voteBreakdown).toMatchObject({ correct: 2, incorrect: 3 });
  });

  it("breaks tie at votes=2 with the first response", async () => {
    const provider = makeProvider(["yes", "no"]);
    const result = await judgeAnswer(
      provider, "single-session-user", "q1", "question?", "gold", "predicted",
      { votes: 2 }
    );
    expect(result.verdict).toBe("CORRECT");
  });

  it("drops a failed call and proceeds with N-1", async () => {
    const failingProvider: LlmProvider = {
      name: "openai",
      complete: vi
        .fn()
        .mockResolvedValueOnce("yes")
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValueOnce("yes"),
    };
    const result = await judgeAnswer(
      failingProvider, "single-session-user", "q1", "question?", "gold", "predicted",
      { votes: 3 }
    );
    expect(result.verdict).toBe("CORRECT");
    expect(result.voteBreakdown).toMatchObject({ correct: 2, incorrect: 0 });
    expect(result.voteBreakdown?.rawResponses).toHaveLength(2);
  });

  it("calls the judge in parallel (sub-linear wall time)", async () => {
    const slowProvider: LlmProvider = {
      name: "openai",
      complete: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return "yes";
      }),
    };
    const start = performance.now();
    await judgeAnswer(
      slowProvider, "single-session-user", "q1", "question?", "gold", "predicted",
      { votes: 5 }
    );
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(150); // 5×50ms serial = 250ms; parallel ≈ 50-100ms
  });
});
