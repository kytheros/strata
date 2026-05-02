/**
 * Frozen eval for Community retrieval TIR + QDP (TIRQDP-1.10).
 *
 * Each scenario seeds an in-memory SQLite database with knowledge_turns and
 * knowledge entries (via SqliteKnowledgeTurnStore + SqliteKnowledgeStore),
 * runs fuseCommunityLanes + recallQdpCommunity, and scores the top-3 results
 * against expected substrings.
 *
 * No LLM in the loop — pure retrieval signal. Re-running produces identical
 * scores (FTS5 + RRF + rules only, no embedding randomness).
 *
 * Spec: 2026-05-01-tirqdp-community-port-plan.md §TIRQDP-1.10
 * Ship gate: ≥9/10 scenarios pass.
 * DO NOT modify this file or scenarios/** during optimization.
 */

import { readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteKnowledgeTurnStore } from "../../src/storage/sqlite-knowledge-turn-store.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import { fuseCommunityLanes, type CommunityChunkResult } from "../../src/search/recall-fusion-community.js";
import { recallQdpCommunity } from "../../src/search/recall-qdp-community.js";
import type { KnowledgeTurnInput } from "../../src/storage/interfaces/knowledge-turn-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Scenario shape ────────────────────────────────────────────────────────────

interface SeedTurn {
  speaker: string;
  content: string;
  message_index: number;
  project: string;
  user_id: string;
  /** Optional: override session_id so multi-session scenarios can group turns */
  session_id?: string;
  /** Optional: override created_at (ms epoch) for recency-ordering scenarios */
  created_at?: number;
}

interface SeedEntry {
  id: string;
  summary: string;
  details: string;
  type: string;
  project: string;
  user: string;
  tags: string[];
}

interface Scenario {
  id: string;
  description: string;
  seed_turns: SeedTurn[];
  seed_entries: SeedEntry[];
  query: string;
  /** query_user_id and query_project scope the turn-store search */
  query_user_id: string;
  query_project?: string;
  expected_top_3_contains: string[];
  must_not_contain: string[];
}

interface ScenarioResult {
  id: string;
  passed: boolean;
  score: number;
  topTexts: string[];
  details?: string;
}

// ── Run one scenario ──────────────────────────────────────────────────────────

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  // In-memory database — fully isolated per scenario
  const db = openDatabase(":memory:");

  const turnStore = new SqliteKnowledgeTurnStore(db);
  const knowledgeStore = new SqliteKnowledgeStore(db, /* embedder */ null);

  // 1. Seed turns
  const now = Date.now();
  for (const t of scenario.seed_turns) {
    const input: KnowledgeTurnInput = {
      sessionId: t.session_id ?? "eval-session",
      project: t.project,
      userId: t.user_id,
      speaker: t.speaker,
      content: t.content,
      messageIndex: t.message_index,
    };
    // Insert via bulkInsert is fine; use insert() for per-turn created_at control
    if (t.created_at !== undefined) {
      // Directly insert to preserve custom created_at
      db.prepare(
        `INSERT INTO knowledge_turns (turn_id, session_id, project, user_id, speaker, content, message_index, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        `turn-${t.message_index}-${t.project}-${t.user_id}`,
        t.session_id ?? "eval-session",
        t.project,
        t.user_id,
        t.speaker,
        t.content,
        t.message_index,
        t.created_at,
      );
    } else {
      await turnStore.insert(input);
    }
  }

  // 2. Seed knowledge entries
  for (const e of scenario.seed_entries) {
    await knowledgeStore.addEntry({
      id: e.id,
      type: e.type as "solution" | "decision" | "error_fix" | "pattern" | "learning" | "procedure" | "fact" | "preference" | "episodic",
      project: e.project,
      user: e.user,
      sessionId: "eval-session",
      timestamp: now,
      summary: e.summary,
      details: e.details,
      tags: e.tags,
      relatedFiles: [],
    });
  }

  // 3. Run retrieval pipeline
  const turnHits = await turnStore.searchByQuery(scenario.query, {
    userId: scenario.query_user_id,
    project: scenario.query_project,
    limit: 20,
  });

  const chunkHits = await knowledgeStore.search(
    scenario.query,
    scenario.query_project,
    scenario.query_user_id,
  );

  // Adapt KnowledgeEntry → CommunityChunkResult
  const chunkResults: CommunityChunkResult[] = chunkHits.map((e, idx) => ({
    id: e.id,
    score: chunkHits.length - idx, // rank-based score (higher rank = higher score)
    userId: e.user ?? null,
    project: e.project ?? null,
    content: e.summary + (e.details ? " " + e.details : ""),
    tags: e.tags ?? [],
  }));

  const fused = fuseCommunityLanes(chunkResults, turnHits, {});
  const pruned = recallQdpCommunity(fused, scenario.query);
  const top3 = pruned.slice(0, 3).map(r => r.content);

  db.close();

  // 4. Score
  let score = 0;
  for (const expected of scenario.expected_top_3_contains) {
    if (top3.some(t => t.toLowerCase().includes(expected.toLowerCase()))) score++;
  }
  for (const forbidden of scenario.must_not_contain) {
    if (top3.some(t => t.toLowerCase().includes(forbidden.toLowerCase()))) score--;
  }

  const passed = score >= scenario.expected_top_3_contains.length &&
    !scenario.must_not_contain.some(f => top3.some(t => t.toLowerCase().includes(f.toLowerCase())));

  return { id: scenario.id, passed, score, topTexts: top3 };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const scenarioDir = join(__dirname, "scenarios");
  let files: string[];
  try {
    files = readdirSync(scenarioDir).filter(f => f.endsWith(".json")).sort();
  } catch {
    console.error("No scenarios directory found at", scenarioDir);
    process.exit(2);
  }

  if (files.length === 0) {
    console.error("No scenarios found in", scenarioDir);
    process.exit(2);
  }

  const results: ScenarioResult[] = [];
  for (const f of files) {
    const scenario = JSON.parse(readFileSync(join(scenarioDir, f), "utf-8")) as Scenario;
    const result = await runScenario(scenario);
    results.push(result);
  }

  const passed = results.filter(r => r.passed).length;
  const total = results.length;

  console.log("");
  console.log("═══ Community Recall TIR + QDP Eval (TIRQDP-1.10) ═══");
  for (const r of results) {
    const mark = r.passed ? "✓" : "✗";
    console.log(`  ${mark} ${r.id.padEnd(36)} score=${r.score}`);
    if (!r.passed) {
      console.log(`     top3:`);
      for (const t of r.topTexts) console.log(`       · ${t.slice(0, 120)}`);
    }
  }
  console.log("");
  console.log(`  Total: ${passed}/${total}`);
  console.log("");

  let decision: string;
  if (passed >= total)        decision = "SHIP — all scenarios pass";
  else if (passed >= 9)       decision = "SHIP — ≥9/10 gate met";
  else if (passed >= 7)       decision = "INVESTIGATE — below ship gate (need ≥9)";
  else                        decision = "RE-EVALUATE";
  console.log(`  Decision: ${decision}`);
  console.log("");

  process.exit(passed >= 9 ? 0 : 1);
}

main().catch(err => {
  console.error("Eval failed:", err);
  process.exit(1);
});
