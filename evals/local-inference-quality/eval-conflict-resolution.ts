/**
 * Conflict resolution quality eval.
 *
 * Loads fixtures/conflict-cases.json, runs each candidate+similar pair
 * through a provider, and scores by action-type classification accuracy.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { LlmProvider } from "../../src/extensions/llm-extraction/llm-provider.js";
import type { EvalResult } from "./eval-extraction.js";
import { parseJsonResponse } from "./strip-json-fence.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ConflictFixture {
  id: string;
  candidate: { type: string; summary: string; details: string };
  similar: Array<{ id: string; type: string; summary: string; details: string }>;
  expected_action: "add" | "delete" | "update" | "noop";
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}

function buildPrompt(fixture: ConflictFixture): string {
  const similarList =
    fixture.similar.length === 0
      ? "(none)"
      : fixture.similar
          .map((s) => `- id=${s.id} type=${s.type} summary="${s.summary}" details="${s.details}"`)
          .join("\n");

  return `Decide whether to add, update, or delete knowledge based on a new candidate entry
and existing similar entries. Return ONLY valid JSON:
{"shouldAdd":true|false,"actions":[{"action":"delete|update","targetId":"..."}]}

Rules:
- If no similar entries exist: shouldAdd=true, actions=[]
- If the candidate contradicts a similar entry: shouldAdd=false, actions=[{"action":"delete","targetId":"..."}]
- If the candidate refines/extends a similar entry: shouldAdd=false, actions=[{"action":"update","targetId":"..."}]
- If the candidate duplicates a similar entry: shouldAdd=false, actions=[]

Candidate: type=${fixture.candidate.type} summary="${fixture.candidate.summary}" details="${fixture.candidate.details}"

Similar entries:
${similarList}`;
}

function classifyResolution(parsed: unknown): "add" | "delete" | "update" | "noop" | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const r = parsed as { shouldAdd?: unknown; actions?: unknown };
  if (typeof r.shouldAdd !== "boolean" || !Array.isArray(r.actions)) return null;

  const actions = r.actions as Array<{ action?: string }>;
  if (r.shouldAdd && actions.length === 0) return "add";
  if (!r.shouldAdd && actions.length === 0) return "noop";
  if (actions.some((a) => a.action === "delete")) return "delete";
  if (actions.some((a) => a.action === "update")) return "update";
  return null;
}

export async function evalConflictResolution(provider: LlmProvider): Promise<EvalResult> {
  const fixturesPath = join(__dirname, "fixtures", "conflict-cases.json");
  const fixtures: ConflictFixture[] = JSON.parse(readFileSync(fixturesPath, "utf-8"));

  const latencies: number[] = [];
  const details: EvalResult["details"] = [];
  let passed = 0;

  for (const fixture of fixtures) {
    const prompt = buildPrompt(fixture);
    const start = Date.now();
    let pass = false;
    let reason = "";
    let raw = "";
    try {
      raw = await provider.complete(prompt, {
        maxTokens: 512,
        temperature: 0.0,
        timeoutMs: 20000,
        jsonMode: true,
      });
      const parsed = parseJsonResponse(raw);
      const classified = classifyResolution(parsed);
      if (!classified) {
        reason = "unclassifiable output";
      } else if (classified !== fixture.expected_action) {
        reason = `expected ${fixture.expected_action}, got ${classified}`;
      } else {
        pass = true;
        reason = "OK";
        passed += 1;
      }
    } catch (err) {
      const preview = raw.slice(0, 200).replace(/\n/g, "\\n");
      reason = `error: ${err instanceof Error ? err.message : String(err)} | raw[:200]="${preview}"`;
    }

    const ms = Date.now() - start;
    latencies.push(ms);
    details.push({ id: fixture.id, pass, reason, latencyMs: ms });
  }

  const sorted = [...latencies].sort((a, b) => a - b);

  return {
    providerName: provider.name,
    totalCases: fixtures.length,
    passed,
    score: passed / fixtures.length,
    latencyP50Ms: percentile(sorted, 0.5),
    latencyP95Ms: percentile(sorted, 0.95),
    details,
  };
}
