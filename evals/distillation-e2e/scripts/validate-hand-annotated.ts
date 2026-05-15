#!/usr/bin/env tsx
import { loadFixtures } from "../lib/fixture-loader.js";

const all = loadFixtures("evals/distillation-e2e/fixtures");
const fx = all.filter((f) => f.source === "hand-annotated");
console.log("loaded", fx.length, "hand-annotated fixtures (", all.length, "total)\n");

const byMode: Record<string, number> = {};
for (const f of fx) {
  const sessIds = new Set(f.sessions.map((s) => s.id));
  for (const ev of f.expected_evidence_turns) {
    if (!sessIds.has(ev.session_id)) {
      console.error(`FAIL ${f.id}: evidence references unknown session_id ${ev.session_id}`);
      process.exit(1);
    }
    const sess = f.sessions.find((s) => s.id === ev.session_id)!;
    if (ev.turn_index >= sess.turns.length) {
      console.error(`FAIL ${f.id}: evidence turn_index ${ev.turn_index} out of range (session ${ev.session_id} has ${sess.turns.length} turns)`);
      process.exit(1);
    }
  }
  byMode[f.failure_mode ?? "none"] = (byMode[f.failure_mode ?? "none"] ?? 0) + 1;
  const totalTurns = f.sessions.reduce((s, x) => s + x.turns.length, 0);
  const evRefs = f.expected_evidence_turns.map((e) => `${e.session_id}.${e.turn_index}`).join(",");
  console.log(`  ${f.id.padEnd(28)} ${(f.failure_mode ?? "").padEnd(20)} ${f.sessions.length}sess ${totalTurns}t  evidence@${evRefs}`);
}

console.log("\nby failure_mode:", byMode);
console.log("\nALL FIXTURES VALID");
