import { describe, it, expect, vi, afterEach } from "vitest";
import type { SearchResult } from "../../src/search/sqlite-search-engine.js";
import {
  answerWithGapCoverage,
  unionAndDedup,
  type GapCoverageOptions,
  type GapCoverageDeps,
} from "../../benchmarks/longmemeval/gap-coverage.js";

// Minimal SearchResult factory — only fields gap-coverage.ts uses
function makeResult(sessionId: string, text: string, score = 1.0): SearchResult {
  return {
    sessionId,
    project: "test",
    text,
    score,
    confidence: score,
    timestamp: 0,
    toolNames: [],
    role: "user",
  };
}

const OPTS: GapCoverageOptions = { maxRounds: 1 };

describe("answerWithGapCoverage", () => {
  it("returns draft unchanged when gap-judge says sufficient", async () => {
    const deps: GapCoverageDeps = {
      retrieve: vi.fn(),
      judgeGap: vi.fn(async () => ({ sufficient: true, gaps: [] })),
      generateAnswer: vi.fn(),
    };
    const retrieved = [makeResult("s1", "some evidence")];
    const result = await answerWithGapCoverage(
      "Q?", "2024-01-01", retrieved, "draft answer", deps, OPTS
    );
    expect(result.answer).toBe("draft answer");
    expect(result.fired).toBe(false);
    expect(deps.retrieve).not.toHaveBeenCalled();
    expect(deps.generateAnswer).not.toHaveBeenCalled();
  });

  it("re-answers when insufficient and new chunks found", async () => {
    const newChunk = makeResult("s2", "new evidence");
    const deps: GapCoverageDeps = {
      retrieve: vi.fn(async () => [newChunk]),
      judgeGap: vi.fn(async () => ({
        sufficient: false,
        gaps: [{ missing: "date of purchase", suggestedQuery: "when bought laptop" }],
      })),
      generateAnswer: vi.fn(async () => ({ answer: "re-answer", latencyMs: 10 })),
    };
    const retrieved = [makeResult("s1", "original evidence")];
    const result = await answerWithGapCoverage(
      "Q?", "2024-01-01", retrieved, "draft answer", deps, OPTS
    );
    expect(result.answer).toBe("re-answer");
    expect(result.fired).toBe(true);
    expect(result.newChunkIds).toContain("s2");
    expect(result.rounds).toBe(1);
    // generateAnswer called with superset context (s1 + s2)
    const callCtx = (deps.generateAnswer as ReturnType<typeof vi.fn>).mock.calls[0][2] as SearchResult[];
    expect(callCtx.map(r => r.sessionId)).toContain("s1");
    expect(callCtx.map(r => r.sessionId)).toContain("s2");
  });

  it("keeps draft when insufficient but no new chunks found", async () => {
    const deps: GapCoverageDeps = {
      retrieve: vi.fn(async () => [makeResult("s1", "same evidence")]), // same sessionId as original
      judgeGap: vi.fn(async () => ({
        sufficient: false,
        gaps: [{ missing: "X", suggestedQuery: "find X" }],
      })),
      generateAnswer: vi.fn(),
    };
    const retrieved = [makeResult("s1", "original evidence")];
    const result = await answerWithGapCoverage(
      "Q?", "2024-01-01", retrieved, "draft answer", deps, OPTS
    );
    expect(result.answer).toBe("draft answer");
    expect(result.fired).toBe(true);
    expect(result.newChunkIds).toEqual([]);
    expect(deps.generateAnswer).not.toHaveBeenCalled();
  });

  it("fails open on judge error — keeps draft", async () => {
    const deps: GapCoverageDeps = {
      retrieve: vi.fn(),
      judgeGap: vi.fn(async () => { throw new Error("LLM timeout"); }),
      generateAnswer: vi.fn(),
    };
    const retrieved = [makeResult("s1", "evidence")];
    const result = await answerWithGapCoverage(
      "Q?", "2024-01-01", retrieved, "draft answer", deps, OPTS
    );
    expect(result.answer).toBe("draft answer");
    expect(result.fired).toBe(false);
    expect(deps.generateAnswer).not.toHaveBeenCalled();
  });

  it("fails open on re-retrieval error — keeps draft", async () => {
    const deps: GapCoverageDeps = {
      retrieve: vi.fn(async () => { throw new Error("DB error"); }),
      judgeGap: vi.fn(async () => ({
        sufficient: false,
        gaps: [{ missing: "X", suggestedQuery: "q" }],
      })),
      generateAnswer: vi.fn(),
    };
    const retrieved = [makeResult("s1", "evidence")];
    const result = await answerWithGapCoverage(
      "Q?", "2024-01-01", retrieved, "draft answer", deps, OPTS
    );
    expect(result.answer).toBe("draft answer");
    expect(result.fired).toBe(false);
  });

  it("fires at most one round regardless of gaps remaining", async () => {
    let callCount = 0;
    const deps: GapCoverageDeps = {
      retrieve: vi.fn(async () => [makeResult(`s${++callCount + 1}`, "new")]),
      judgeGap: vi.fn(async () => ({
        sufficient: false,
        gaps: [
          { missing: "A", suggestedQuery: "q1" },
          { missing: "B", suggestedQuery: "q2" },
        ],
      })),
      generateAnswer: vi.fn(async () => ({ answer: "re-answer", latencyMs: 5 })),
    };
    const retrieved = [makeResult("s1", "evidence")];
    const result = await answerWithGapCoverage(
      "Q?", "2024-01-01", retrieved, "draft answer", deps, { maxRounds: 1 }
    );
    // Only ONE round of re-retrieval regardless of gap count
    expect(result.rounds).toBe(1);
    // retrieve called once per gap item (2 gaps → 2 retrieve calls) but only 1 round
    expect((deps.retrieve as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });
});

describe("unionAndDedup", () => {
  it("preserves original order and appends new sessions after", () => {
    const orig = [makeResult("s1", "a"), makeResult("s2", "b")];
    const additions = [makeResult("s3", "c"), makeResult("s1", "dup")];
    const result = unionAndDedup(orig, additions);
    expect(result.map(r => r.sessionId)).toEqual(["s1", "s2", "s3"]);
  });

  it("deduplicates by sessionId — first occurrence wins", () => {
    const orig = [makeResult("s1", "original")];
    const additions = [makeResult("s1", "replacement")];
    const result = unionAndDedup(orig, additions);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("original");
  });
});
