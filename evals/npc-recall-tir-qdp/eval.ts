/**
 * Frozen eval for NPC recall TIR + QDP (Phase 0).
 *
 * Each scenario seeds an in-memory world.db with stored_turns (turn-store) and
 * stored_memories (memory engine), runs the recall pipeline against the query,
 * and scores the top-3 against expected substrings.
 *
 * No LLM in the loop — pure retrieval signal.
 *
 * Spec: 2026-04-26-npc-recall-tir-qdp-design.md §Frozen retrieval eval.
 * DO NOT modify this file or scenarios/** during optimization.
 */

import { readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import { applySchema } from "../../src/transports/world-schema.js";
import { NpcTurnStore } from "../../src/transports/npc-turn-store.js";
import { NpcMemoryEngine } from "../../src/transports/npc-memory-engine.js";
import { fuseRecallLanes, type RecallCandidate } from "../../src/transports/recall-fusion.js";
import { recallQdp } from "../../src/transports/recall-qdp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface StoredTurn { speaker: string; content: string }
interface StoredMemory { content: string; tags?: string[]; importance?: number }
interface Scenario {
  name: string;
  npc_id?: string;
  stored_turns: StoredTurn[];
  stored_memories: StoredMemory[];
  query: string;
  expected_top_3_contains: string[];
  must_not_contain: string[];
}

interface ScenarioResult { name: string; score: number; passed: boolean; topTexts: string[] }

function runScenario(scenario: Scenario): ScenarioResult {
  const npcId = scenario.npc_id ?? "test-npc";
  const db = new Database(":memory:");
  applySchema(db);
  const turnStore = new NpcTurnStore(db);
  const engine = new NpcMemoryEngine(db, npcId);

  for (const t of scenario.stored_turns) {
    turnStore.add({ npcId, playerId: "p", speaker: t.speaker, content: t.content });
  }
  for (const m of scenario.stored_memories) {
    engine.add({
      content: m.content,
      tags: m.tags ?? [],
      importance: m.importance ?? 50,
    });
  }

  const turnHits = turnStore.search(scenario.query, { npcId, limit: 10 });
  const factHits = engine.search(scenario.query);
  const turnList: RecallCandidate[] = turnHits.map(t => ({
    id: t.turnId, score: t.bm25, source: "turn", content: t.content, tags: [],
  }));
  const factList: RecallCandidate[] = factHits.map(m => ({
    id: m.id, score: m.importance / 100, source: "fact", content: m.content, tags: m.tags,
  }));
  const fused = fuseRecallLanes([turnList, factList]);
  const pruned = recallQdp(fused, scenario.query);
  const top3 = pruned.slice(0, 3).map(c => c.content);
  db.close();

  let score = 0;
  for (const expected of scenario.expected_top_3_contains) {
    if (top3.some(t => t.toLowerCase().includes(expected.toLowerCase()))) score++;
  }
  for (const forbidden of scenario.must_not_contain) {
    if (top3.some(t => t.toLowerCase().includes(forbidden.toLowerCase()))) score--;
  }

  // Pass criterion: every expected substring appears AND no forbidden substring leaks.
  // Score equals expected count = perfect recall (no leak penalty applied).
  // For abstention scenarios (expected_top_3_contains is empty), score must be ≥ 0
  // (i.e., no forbidden substring leaked — top-3 was either empty or unrelated).
  const passed = score >= scenario.expected_top_3_contains.length;
  return { name: scenario.name, score, passed, topTexts: top3 };
}

function main() {
  const scenarioDir = join(__dirname, "scenarios");
  const files = readdirSync(scenarioDir).filter(f => f.endsWith(".json"));
  if (files.length === 0) {
    console.error("No scenarios found in", scenarioDir);
    process.exit(2);
  }

  const results: ScenarioResult[] = [];
  for (const f of files.sort()) {
    const s = JSON.parse(readFileSync(join(scenarioDir, f), "utf-8")) as Scenario;
    results.push(runScenario(s));
  }

  const passed = results.filter(r => r.passed).length;
  const total = results.length;

  console.log("");
  console.log("═══ NPC Recall TIR + QDP Eval (Phase 0) ═══");
  for (const r of results) {
    const mark = r.passed ? "✓" : "✗";
    console.log(`  ${mark} ${r.name.padEnd(32)} score=${r.score}`);
    if (!r.passed) {
      console.log(`     top3:`);
      for (const t of r.topTexts) console.log(`       · ${t}`);
    }
  }
  console.log("");
  console.log(`  Total: ${passed}/${total}`);
  console.log("");

  let decision: string;
  if (passed >= 8)      decision = "SHIP Phase 0";
  else if (passed >= 5) decision = "SHIP Phase 0; plan Phase 1 (LLM-QDP)";
  else                  decision = "RE-EVALUATE — possibly Phase 2 (deprecate npc_memories from recall)";
  console.log(`  Decision: ${decision}`);

  process.exit(passed >= 5 ? 0 : 1);
}

main();
