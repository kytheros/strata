import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedProvider } from "./integrity-gate.js";
import type { FailureMode, LongMemEvalTaskType } from "./fixture-types.js";

export interface RunRecord {
  timestamp: string;
  gitSha: string;
  provider: ResolvedProvider;
  modelVersions: {
    extraction: string;
    summarization: string;
    conflict: string;
    judge: string;
  };
  retrievalConfigHash: string;
  ollamaParallel: number;
  nValue: 1 | 3;
  wallTimeMs: number;
  fixtureCount: number;
  scores: {
    answerAccuracy: number;
    recallAt10: number;
    perFailureMode: Partial<Record<FailureMode, number>>;
    perTaskType: Partial<Record<LongMemEvalTaskType, number>>;
  };
}

export function writeRunRecord(runsDir: string, record: RunRecord): string {
  mkdirSync(runsDir, { recursive: true });
  const safeTs = record.timestamp.replace(/[:.]/g, "-");
  const path = join(runsDir, `${safeTs}-${record.gitSha}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2));
  return path;
}

export interface LabelledRun {
  label: string;
  record: RunRecord;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function formatComparisonTable(runs: LabelledRun[]): string {
  const lines: string[] = [];
  lines.push("=".repeat(80));
  lines.push("  Distillation E2E Harness — Comparison Table");
  lines.push("=".repeat(80));
  lines.push(`  ${"Provider".padEnd(24)}  ${"Answer".padEnd(10)}  ${"Recall@10".padEnd(12)}  Wall`);
  lines.push("  " + "-".repeat(78));
  for (const r of runs) {
    const wall = `${(r.record.wallTimeMs / 60000).toFixed(1)} min`;
    lines.push(
      `  ${r.label.padEnd(24)}  ${pct(r.record.scores.answerAccuracy).padEnd(10)}  ${pct(r.record.scores.recallAt10).padEnd(12)}  ${wall}`
    );
  }
  lines.push("");
  return lines.join("\n");
}
