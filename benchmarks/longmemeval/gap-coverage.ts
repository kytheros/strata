/**
 * Gap-Coverage Wrapper — spec: specs/2026-05-31-gap-judge-coverage-wrapper-design.md
 *
 * One-round bounded sufficiency check bolted onto the direct pipeline.
 * If gap-judge says evidence is sufficient, the draft answer stands unchanged.
 * If insufficient, attempts one round of re-retrieval seeded from gap items;
 * re-answers only when new (not already seen) chunks are found.
 * Fails open on any error — never deadlocks or loses a draft answer.
 */
import type { SearchResult } from "../../src/search/sqlite-search-engine.js";
import type { GapVerdict } from "./gap-judge.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GapCoverageDeps {
  /** Run a retrieval query; returns SearchResult[] sorted by score descending. */
  retrieve: (query: string) => Promise<SearchResult[]>;
  /** Gap-judge: wraps judgeGap from gap-judge.ts with complete already injected. */
  judgeGap: (question: string, evidenceDigest: string) => Promise<GapVerdict>;
  /** Re-answer function: (question, questionDate, context, opts) */
  generateAnswer: (
    question: string,
    questionDate: string,
    context: SearchResult[],
    opts?: Record<string, unknown>
  ) => Promise<{ answer: string; latencyMs: number }>;
}

export interface GapCoverageOptions {
  /** Number of re-retrieval rounds (default 1, spec-maximum). */
  maxRounds?: number;
  /** Extra options forwarded to generateAnswer for re-answer call (e.g. topK, promptVariant). */
  answerOpts?: Record<string, unknown>;
}

export interface GapCoverageResult {
  /** Final answer: either draft (fired=false) or re-answer (fired=true, newChunkIds non-empty). */
  answer: string;
  /** Whether gap-judge fired (i.e. returned insufficient). */
  fired: boolean;
  /** Session IDs of chunks that were NEW (not in original retrieved set). Empty if none found. */
  newChunkIds: string[];
  /** How many re-retrieval rounds ran (0 or 1 with maxRounds=1). */
  rounds: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a plain-text evidence digest from SearchResult[] for gap-judge.
 * Formats each chunk as "Session <n> (sessionId):\n<text>\n" — a short,
 * token-efficient representation. gap-judge needs enough text to decide
 * sufficiency; full verbatim content is not required.
 */
function buildEvidenceDigest(results: SearchResult[]): string {
  return results
    .map((r, i) => `Session ${i + 1} (${r.sessionId}):\n${r.text}`)
    .join("\n\n");
}

/**
 * Union original and new SearchResult[] by sessionId, preserving original
 * ordering and appending only chunks whose sessionId has not been seen yet.
 * The first occurrence of any sessionId wins — original context is not
 * displaced by a re-retrieved version of the same session.
 */
export function unionAndDedup(
  original: SearchResult[],
  additions: SearchResult[]
): SearchResult[] {
  const seen = new Set(original.map(r => r.sessionId));
  const merged = [...original];
  for (const r of additions) {
    if (!seen.has(r.sessionId)) {
      seen.add(r.sessionId);
      merged.push(r);
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Wrap the direct-pipeline answer with a one-round gap-coverage check.
 *
 * Flow:
 *   1. Build evidence digest from `retrieved`.
 *   2. Call deps.judgeGap(question, digest).
 *      - sufficient → return { answer: draftAnswer, fired: false }  (fast path)
 *      - error      → return { answer: draftAnswer, fired: false }  (fail-open)
 *   3. For each gap item, call deps.retrieve(gap.suggestedQuery ?? gap.missing).
 *      Collect chunks whose sessionId is NOT already in `retrieved`.
 *      - no new chunks → return { answer: draftAnswer, fired: true, newChunkIds: [] }
 *        (avoid a re-answer with identical context)
 *   4. Build context' = unionAndDedup(retrieved, newChunks).
 *   5. Call deps.generateAnswer(question, questionDate, context', opts).
 *      - error → return { answer: draftAnswer, fired: true, newChunkIds }  (fail-open)
 *   6. Return { answer: reAnswer, fired: true, newChunkIds, rounds: 1 }.
 */
export async function answerWithGapCoverage(
  question: string,
  questionDate: string,
  retrieved: SearchResult[],
  draftAnswer: string,
  deps: GapCoverageDeps,
  opts: GapCoverageOptions = {}
): Promise<GapCoverageResult> {
  const maxRounds = opts.maxRounds ?? 1;
  const answerOpts = opts.answerOpts ?? {};

  // Step 1: build evidence digest
  const digest = buildEvidenceDigest(retrieved);

  // Step 2: run gap judge — fail-open on any error
  let verdict: GapVerdict;
  try {
    verdict = await deps.judgeGap(question, digest);
  } catch {
    return { answer: draftAnswer, fired: false, newChunkIds: [], rounds: 0 };
  }

  if (verdict.sufficient) {
    return { answer: draftAnswer, fired: false, newChunkIds: [], rounds: 0 };
  }

  // Step 3: one round of re-retrieval for each gap item
  // (spec: one round; maxRounds=1 is the enforced default)
  const originalIds = new Set(retrieved.map(r => r.sessionId));
  const newChunks: SearchResult[] = [];
  let atLeastOneRetrieveSucceeded = false;

  if (maxRounds >= 1 && verdict.gaps.length > 0) {
    for (const gap of verdict.gaps) {
      const query = gap.suggestedQuery ?? gap.missing;
      try {
        const results = await deps.retrieve(query);
        atLeastOneRetrieveSucceeded = true;
        for (const r of results) {
          if (!originalIds.has(r.sessionId)) {
            originalIds.add(r.sessionId); // prevent duplicates across gap queries
            newChunks.push(r);
          }
        }
      } catch {
        // Fail-open: retrieve error for one gap item does not abort the whole round
        continue;
      }
    }
  }

  const newChunkIds = newChunks.map(r => r.sessionId);

  // Step 4a: if ALL retrieve calls failed (no successful retrieve), fail-open entirely
  if (!atLeastOneRetrieveSucceeded && verdict.gaps.length > 0) {
    return { answer: draftAnswer, fired: false, newChunkIds: [], rounds: 0 };
  }

  // Step 4b: if no new chunks (but retrieve succeeded — just found duplicates), keep draft
  if (newChunks.length === 0) {
    return { answer: draftAnswer, fired: true, newChunkIds: [], rounds: 1 };
  }

  // Step 5: context union (original order preserved, new chunks appended)
  const contextPrime = unionAndDedup(retrieved, newChunks);

  // Step 6: re-answer — fail-open
  try {
    const { answer: reAnswer } = await deps.generateAnswer(
      question,
      questionDate,
      contextPrime,
      answerOpts
    );
    return { answer: reAnswer, fired: true, newChunkIds, rounds: 1 };
  } catch {
    return { answer: draftAnswer, fired: true, newChunkIds, rounds: 1 };
  }
}
