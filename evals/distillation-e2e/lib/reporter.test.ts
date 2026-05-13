import { describe, expect, test, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeRunRecord, formatComparisonTable, type RunRecord } from "./reporter.js";

describe("reporter", () => {
  let runsDir: string;
  beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), "runs-")); });

  const record: RunRecord = {
    timestamp: "2026-05-11T12:00:00Z",
    gitSha: "abc1234",
    provider: { kind: "gemini" },
    modelVersions: {
      extraction: "gemini-2.5-flash",
      summarization: "gemini-2.5-flash",
      conflict: "gemini-2.5-flash",
      judge: "gpt-4o-2024-08-06",
    },
    retrievalConfigHash: "deadbeef",
    ollamaParallel: 4,
    nValue: 1,
    wallTimeMs: 5400000,
    fixtureCount: 36,
    scores: {
      answerAccuracy: 0.83,
      recallAt10: 0.91,
      perFailureMode: {},
      perTaskType: {},
    },
  };

  test("writes JSON record under runs/<timestamp>-<sha>.json", () => {
    const path = writeRunRecord(runsDir, record);
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.gitSha).toBe("abc1234");
    expect(parsed.scores.answerAccuracy).toBe(0.83);
  });

  test("formatComparisonTable prints stage rows for both providers", () => {
    const out = formatComparisonTable([
      { label: "gemini", record },
      { label: "gemma4:e4b", record: { ...record, provider: { kind: "ollama", model: "gemma4:e4b" } } },
    ]);
    expect(out).toContain("gemini");
    expect(out).toContain("gemma4:e4b");
    expect(out).toContain("83.0%");
    expect(out).toContain("91.0%");
  });
});
