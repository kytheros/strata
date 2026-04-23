/**
 * Frozen eval for NPC narrative integrity.
 *
 * Runs each scenario against a throwaway SQLite DB, drives the extraction
 * worker inline (no HTTP), then scores the resulting store against the
 * scenario's assertions. See
 * specs/2026-04-22-npc-narrative-integrity-design.md §Testing.
 *
 * DO NOT modify this file or scenarios/** during optimization. The script
 * is the source of truth; treat it like a frozen AutoResearch eval.
 */

import { readdirSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { ExtractionQueueStore } from "../../src/extensions/extraction-queue/queue-store.js";
import { ExtractionWorker } from "../../src/extensions/extraction-queue/extraction-worker.js";
import type { TenantDbResolver } from "../../src/extensions/extraction-queue/tenant-db-resolver.js";
import type { LlmProvider } from "../../src/extensions/llm-extraction/llm-provider.js";
import { getExtractionProvider } from "../../src/extensions/llm-extraction/provider-factory.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Scenario {
  name: string;
  description: string;
  agentId: string;
  seed: { text: string; tags: string[]; importance: number }[];
  turns: { role: "player" | "npc-self"; text: string; tags: string[] }[];
  assertions: Assertion[];
}

type Assertion =
  | { kind: "noConfidentHearsay"; weight: number }
  | { kind: "hearsayTagPresent"; substring: string; weight: number }
  | { kind: "importanceCeil"; substring: string; max: number; weight: number }
  | { kind: "noInventedEntity"; forbidden: string[]; weight: number }
  | { kind: "selfUtterancePenalty"; weight: number };

interface Row { text: string; tags: string[]; importance: number }

async function runScenario(scenario: Scenario, provider: LlmProvider): Promise<number> {
  const tmp = mkdtempSync(join(tmpdir(), "npc-eval-"));
  try {
    const queue = new ExtractionQueueStore(join(tmp, "queue.db"));
    const written: Row[] = [...scenario.seed];
    const resolver: TenantDbResolver = {
      async withTenantDb(_tenant, _agent, fn) {
        await fn({
          kind: "legacy",
          agentId: _agent,
          async addEntry(text: string, tags: string[], importance: number) {
            written.push({ text, tags, importance });
            return String(written.length);
          },
        } as unknown as Parameters<typeof fn>[0]);
      },
    } as unknown as TenantDbResolver;

    const worker = new ExtractionWorker({ queue, provider, tenantResolver: resolver });
    for (const turn of scenario.turns) {
      queue.enqueue({
        tenantId: "legacy:eval", agentId: scenario.agentId,
        memoryId: String(written.length + 1), text: turn.text, userTags: turn.tags,
      });
      await worker.runOnce();
    }

    let gained = 0;
    let possible = 0;
    for (const a of scenario.assertions) {
      possible += a.weight;
      if (scoreAssertion(a, written)) gained += a.weight;
    }
    const ratio = possible === 0 ? 0 : gained / possible;
    console.log(`  ${scenario.name}: ${gained}/${possible} (${(ratio * 100).toFixed(1)}%)`);
    queue.close();
    return ratio;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function rowsMatching(sub: string, rows: Row[]): Row[] {
  const needle = sub.toLowerCase();
  return rows.filter((r) => r.text.toLowerCase().includes(needle));
}

function scoreAssertion(a: Assertion, rows: Row[]): boolean {
  switch (a.kind) {
    case "noConfidentHearsay": {
      const bad = rows.filter((r) => r.tags.includes("hearsay") && r.importance > 40);
      return bad.length === 0;
    }
    case "hearsayTagPresent": {
      const hits = rowsMatching(a.substring, rows);
      return hits.length > 0 && hits.every((r) => r.tags.includes("hearsay"));
    }
    case "importanceCeil": {
      const hits = rowsMatching(a.substring, rows);
      return hits.length > 0 && hits.every((r) => r.importance <= a.max);
    }
    case "noInventedEntity": {
      const forbidden = a.forbidden.map((f) => f.toLowerCase());
      return !rows.some((r) => forbidden.some((f) => r.text.toLowerCase().includes(f)));
    }
    case "selfUtterancePenalty": {
      const selfRows = rows.filter((r) => r.tags.includes("self-utterance"));
      return selfRows.length > 0 && selfRows.every((r) => r.importance <= 50);
    }
  }
}

async function main() {
  const provider = await getExtractionProvider();
  if (!provider) {
    console.error("No extraction provider configured (set GEMINI_API_KEY or enable distillation).");
    process.exit(2);
  }
  const dir = join(__dirname, "scenarios");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  let totalGained = 0;
  let totalPossible = 0;
  let zeroScoreScenarios = 0;
  for (const file of files) {
    const scenario = JSON.parse(readFileSync(join(dir, file), "utf-8")) as Scenario;
    const ratio = await runScenario(scenario, provider);
    const possible = scenario.assertions.reduce((s, a) => s + a.weight, 0);
    totalPossible += possible;
    totalGained += ratio * possible;
    if (ratio === 0) zeroScoreScenarios += 1;
  }
  const pct = totalPossible === 0 ? 0 : (totalGained / totalPossible) * 100;
  console.log(`\nTotal: ${totalGained.toFixed(1)}/${totalPossible} (${pct.toFixed(1)}%)`);
  const shipGate = pct >= 85 && zeroScoreScenarios === 0;
  console.log(shipGate ? "SHIP GATE: PASS" : "SHIP GATE: FAIL");
  process.exit(shipGate ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
