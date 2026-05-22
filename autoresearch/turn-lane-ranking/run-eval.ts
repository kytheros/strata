/**
 * Turn-Lane Ranking AutoResearch Eval
 *
 * Exercises the full turn-lane retrieval + ranking pipeline:
 *   query -> classifier -> turn-lane FTS5 -> applyTurnRecencyBoost -> top-k
 *
 * For each of 15 fixtures, indexes the fixture's sessions into an in-memory
 * SqliteKnowledgeTurnStore, runs the query, and scores top-1 + recall@5
 * against expected_evidence_turns.
 *
 * FROZEN: Do not modify this file or the fixture corpus it loads. Run with:
 *   npx tsx autoresearch/turn-lane-ranking/run-eval.ts
 *
 * Spec: 2026-05-22-turn-lane-ranking-autoresearch-design.md
 */

import { readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteKnowledgeTurnStore } from "../../src/storage/sqlite-knowledge-turn-store.js";
import { applyTurnRecencyBoost } from "../../src/search/result-ranker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures");

// ---------------------------------------------------------------------------
// Fixture types
// ---------------------------------------------------------------------------

interface FixtureTurn {
  role: "user" | "assistant";
  content: string;
}

interface FixtureSession {
  id: string;
  created_at: number;
  turns: FixtureTurn[];
}

interface FixtureEvidence {
  session_id: string;
  turn_index: number;
}

interface Fixture {
  id: string;
  source: string;
  failure_mode: string | null;
  longmemeval_task_type: string | null;
  sessions: FixtureSession[];
  query: string;
  expected_answer: string;
  expected_evidence_turns: FixtureEvidence[];
  min_recall_at_k: number;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

function loadFixtures(): Fixture[] {
  const files = readdirSync(FIXTURES_DIR)
    .filter((f) => f.startsWith("ranking-") && f.endsWith(".json"))
    .sort();
  return files.map((f) => JSON.parse(readFileSync(join(FIXTURES_DIR, f), "utf8")) as Fixture);
}

// ---------------------------------------------------------------------------
// Per-fixture eval
// ---------------------------------------------------------------------------

interface FixtureResult {
  id: string;
  query: string;
  top1Hit: boolean;
  recall5Hit: boolean;
  score: number; // 0, 1, or 2
  top5: { session_id: string; turn_index: number }[];
  rankOfFirstExpected: number | null; // 1-indexed; null if not in top-20
}

async function evalFixture(fixture: Fixture): Promise<FixtureResult> {
  // 1. Open in-memory DB with full schema (includes knowledge_turns table).
  const db = openDatabase(":memory:");

  // 2. Insert all turns with createdAt = session.created_at + turnIndex.
  //    This mirrors how pipeline-driver writes turns in production.
  const store = new SqliteKnowledgeTurnStore(db);
  for (const session of fixture.sessions) {
    const inputs = session.turns.map((t, idx) => ({
      sessionId: session.id,
      project: null,
      userId: null,
      speaker: t.role,
      content: t.content,
      messageIndex: idx,
      createdAt: session.created_at + idx,
    }));
    await store.bulkInsert(inputs);
  }

  // 3. Run FTS5 search, then apply turn recency boost.
  const rawHits = await store.searchByQuery(fixture.query, { userId: null, limit: 20 });
  const ranked = applyTurnRecencyBoost(rawHits, fixture.query);

  // 4. Take top-5 and extract (session_id, turn_index) tuples.
  const top5 = ranked.slice(0, 5).map((h) => ({
    session_id: h.row.sessionId,
    turn_index: h.row.messageIndex,
  }));

  // 5. Score.
  const expected = fixture.expected_evidence_turns;
  const top1 = top5[0];
  const top1Hit = !!top1 && expected.some((e) =>
    e.session_id === top1.session_id && e.turn_index === top1.turn_index
  );
  const recall5Hit = expected.every((e) =>
    top5.some((t) => t.session_id === e.session_id && t.turn_index === e.turn_index)
  );
  const score = (top1Hit ? 1 : 0) + (recall5Hit ? 1 : 0);

  // 6. Find rank of first expected turn (1-indexed, in the full ranked list).
  let rankOfFirstExpected: number | null = null;
  for (let i = 0; i < ranked.length; i++) {
    const t = ranked[i];
    if (expected.some((e) => e.session_id === t.row.sessionId && e.turn_index === t.row.messageIndex)) {
      rankOfFirstExpected = i + 1;
      break;
    }
  }

  db.close();
  return { id: fixture.id, query: fixture.query, top1Hit, recall5Hit, score, top5, rankOfFirstExpected };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const fixtures = loadFixtures();
  console.log(`Loaded ${fixtures.length} fixtures from ${FIXTURES_DIR}\n`);

  const results: FixtureResult[] = [];
  const wallStart = Date.now();

  for (const f of fixtures) {
    const r = await evalFixture(f);
    results.push(r);
    const rankStr = r.rankOfFirstExpected !== null ? `rank=${r.rankOfFirstExpected}` : "not-in-top-20";
    console.log(
      `${r.id.padEnd(12)} score=${r.score}/2 top1=${r.top1Hit ? "✓" : "✗"} recall5=${r.recall5Hit ? "✓" : "✗"} ${rankStr}`
    );
  }

  const wallMs = Date.now() - wallStart;
  const total = results.reduce((sum, r) => sum + r.score, 0);
  const ceiling = results.length * 2;
  console.log(`\nFinal score: ${total}/${ceiling}`);
  console.log(`Total runtime: ${wallMs}ms`);

  // Print failure detail per sub-2/2 fixture (for baseline.md authoring).
  const failed = results.filter((r) => r.score < 2);
  if (failed.length > 0) {
    console.log(`\n--- Sub-2/2 fixtures (${failed.length}) ---`);
    for (const r of failed) {
      console.log(`\n${r.id}: ${r.query}`);
      console.log(`  score=${r.score}/2 top1=${r.top1Hit ? "✓" : "✗"} recall5=${r.recall5Hit ? "✓" : "✗"}`);
      console.log(`  rank-of-first-expected: ${r.rankOfFirstExpected ?? "not-in-top-20"}`);
      console.log(`  top-5 returned: ${JSON.stringify(r.top5)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
