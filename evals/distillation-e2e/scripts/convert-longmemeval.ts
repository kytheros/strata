#!/usr/bin/env tsx
/**
 * convert-longmemeval.ts — Task 15, Phase 7.4
 *
 * Converts LongMemEval question objects (longmemeval_s_cleaned.json or similar)
 * into the Fixture schema used by the distillation-e2e harness.
 *
 * Usage:
 *   npx tsx evals/distillation-e2e/scripts/convert-longmemeval.ts \
 *     benchmarks/longmemeval/data/longmemeval_s_cleaned.json \
 *     evals/distillation-e2e/fixtures/longmemeval-borrowed
 *
 * Stratification: picks 5 of each task type (ie, ku, temporal, multi_session)
 * for a total of up to 20 fixtures. If a bucket has fewer than 5, takes all available.
 *
 * Source format notes (longmemeval_s_cleaned.json):
 *   - haystack_session_ids: string[]  — parallel array of session IDs
 *   - haystack_sessions: Turn[][]     — parallel array of session turn arrays
 *   - answer_session_ids: string[]    — subset of haystack_session_ids that contain evidence
 *   - Turns have { role, content, has_answer? } — has_answer marks the evidence turn
 *   - question_type: "single-session-user" | "multi-session" | "temporal-reasoning" |
 *                    "knowledge-update" | "single-session-preference" | "single-session-assistant"
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  Fixture,
  FixtureSession,
  FixtureTurn,
  LongMemEvalTaskType,
} from "../lib/fixture-types.js";

// Raw shape from the LongMemEval JSON file
interface RawTurn {
  role: string;
  content: string;
  has_answer?: boolean;
}

interface LongMemEvalQuestion {
  question_id: string;
  question_type: string;
  question: string;
  // answer can be a string or a number (counting questions have numeric answers)
  answer: string | number;
  haystack_session_ids: string[];
  haystack_sessions: RawTurn[][];
  answer_session_ids: string[];
}

/**
 * Map LongMemEval question_type strings to our four-bucket LongMemEvalTaskType.
 *
 * Actual values observed in longmemeval_s_cleaned.json:
 *   "single-session-user"       → ie  (156 questions)
 *   "single-session-preference" → ie  (30 questions, grouped with ie)
 *   "single-session-assistant"  → ie  (56 questions, grouped with ie)
 *   "knowledge-update"          → ku  (78 questions)
 *   "temporal-reasoning"        → temporal  (133 questions)
 *   "multi-session"             → multi_session  (133 questions)
 */
function inferTaskType(qType: string): LongMemEvalTaskType {
  if (qType.includes("knowledge-update")) return "ku";
  if (qType.includes("temporal")) return "temporal";
  if (qType.includes("multi-session")) return "multi_session";
  return "ie";
}

/**
 * Convert a single LongMemEvalQuestion into a Fixture.
 *
 * Evidence turn strategy: for each answer_session_id, scan its turns for
 * has_answer=true. Use the first such turn index. Fall back to turn_index=0
 * if has_answer is not present (some questions omit it in the haystack turns).
 */
function convert(src: LongMemEvalQuestion): Fixture {
  // Build FixtureSession[] from the parallel arrays
  const sessions: FixtureSession[] = src.haystack_session_ids.map((sid, i) => {
    const rawTurns = src.haystack_sessions[i] ?? [];
    const turns: FixtureTurn[] = rawTurns.map((t) => ({
      // Normalise role: anything that isn't "user" becomes "assistant"
      role: t.role === "user" ? "user" : "assistant",
      content: t.content,
    }));
    return { id: sid, turns };
  });

  // Build a lookup from session_id → its raw turns (for evidence detection)
  const rawBySessionId = new Map<string, RawTurn[]>();
  for (let i = 0; i < src.haystack_session_ids.length; i++) {
    rawBySessionId.set(src.haystack_session_ids[i], src.haystack_sessions[i] ?? []);
  }

  // Find expected evidence turns: prefer has_answer=true, fallback to turn_index 0
  const expectedEvidenceTurns: Array<{ session_id: string; turn_index: number }> =
    src.answer_session_ids.flatMap((sid) => {
      const rawTurns = rawBySessionId.get(sid);
      if (!rawTurns || rawTurns.length === 0) return [];

      // Find first turn with has_answer=true
      const evidenceIdx = rawTurns.findIndex((t) => t.has_answer === true);
      const turnIndex = evidenceIdx >= 0 ? evidenceIdx : 0;
      return [{ session_id: sid, turn_index: turnIndex }];
    });

  return {
    id: `lme-${src.question_id}`,
    source: "longmemeval",
    failure_mode: null,
    longmemeval_task_type: inferTaskType(src.question_type),
    sessions,
    query: src.question,
    // Normalise to string — some counting questions have numeric answers in the source
    expected_answer: String(src.answer),
    expected_evidence_turns: expectedEvidenceTurns,
    min_recall_at_k: 1,
  };
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  const outputDir = process.argv[3];

  if (!inputPath || !outputDir) {
    process.stderr.write(
      "usage: convert-longmemeval.ts <input.json> <output-dir>\n"
    );
    process.exit(1);
  }

  const source = JSON.parse(
    readFileSync(inputPath, "utf8")
  ) as LongMemEvalQuestion[];

  process.stdout.write(
    `Loaded ${source.length} questions from ${inputPath}\n`
  );

  // Stratify into buckets
  const buckets: Record<LongMemEvalTaskType, LongMemEvalQuestion[]> = {
    ie: [],
    ku: [],
    temporal: [],
    multi_session: [],
  };
  for (const q of source) {
    buckets[inferTaskType(q.question_type)].push(q);
  }

  const taskTypes: LongMemEvalTaskType[] = ["ie", "ku", "temporal", "multi_session"];
  const PER_BUCKET = 5;

  const picked: LongMemEvalQuestion[] = [];
  const summary: Record<string, number> = {};
  for (const t of taskTypes) {
    const slice = buckets[t].slice(0, PER_BUCKET);
    picked.push(...slice);
    summary[t] = slice.length;
  }

  process.stdout.write(
    `Stratification: ${JSON.stringify(summary)} → ${picked.length} total\n`
  );

  mkdirSync(outputDir, { recursive: true });

  for (const q of picked) {
    const fixture = convert(q);
    const outPath = join(outputDir, `${fixture.id}.json`);
    writeFileSync(outPath, JSON.stringify(fixture, null, 2));
  }

  process.stdout.write(`wrote ${picked.length} fixtures to ${outputDir}\n`);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(2);
});
