/**
 * Extraction quality eval.
 *
 * Loads fixtures/extraction-cases.json, runs each session through a
 * provider, and scores by keyword recall + min_entries against the
 * frozen expectations.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { LlmProvider } from "../../src/extensions/llm-extraction/llm-provider.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ExtractionFixture {
  id: string;
  session: {
    sessionId: string;
    project: string;
    messages: Array<{ role: string; text: string; timestamp: string }>;
  };
  expected_keywords: string[];
  min_entries: number;
}

export interface EvalResult {
  providerName: string;
  totalCases: number;
  passed: number;
  score: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  details: Array<{ id: string; pass: boolean; reason: string; latencyMs: number }>;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}

function buildPrompt(fixture: ExtractionFixture): string {
  const transcript = fixture.session.messages
    .map((m) => `${m.role.toUpperCase()}: ${m.text}`)
    .join("\n");
  return `Extract durable memory entries from this conversation. Return ONLY valid JSON matching this shape:
{"entries":[{"type":"fact|preference|decision","summary":"...","details":"..."}]}

Conversation:
${transcript}`;
}

export async function evalExtraction(provider: LlmProvider): Promise<EvalResult> {
  const fixturesPath = join(__dirname, "fixtures", "extraction-cases.json");
  const fixtures: ExtractionFixture[] = JSON.parse(readFileSync(fixturesPath, "utf-8"));

  const latencies: number[] = [];
  const details: EvalResult["details"] = [];
  let passed = 0;

  for (const fixture of fixtures) {
    const prompt = buildPrompt(fixture);
    const start = Date.now();
    let raw = "";
    let pass = false;
    let reason = "";
    try {
      raw = await provider.complete(prompt, {
        maxTokens: 4096,
        temperature: 0.1,
        timeoutMs: 60000,
      });
      const parsed = JSON.parse(raw);
      const entries = parsed?.entries;
      if (!Array.isArray(entries)) {
        reason = "no entries array";
      } else if (entries.length < fixture.min_entries) {
        reason = `${entries.length} entries < min ${fixture.min_entries}`;
      } else {
        const combined = entries
          .map((e: { summary?: string; details?: string }) =>
            `${e.summary || ""} ${e.details || ""}`.toLowerCase()
          )
          .join(" ");
        const hit = fixture.expected_keywords.some((kw) => combined.includes(kw.toLowerCase()));
        if (hit) {
          pass = true;
          reason = "OK";
          passed += 1;
        } else {
          reason = `no expected keyword matched (looked for: ${fixture.expected_keywords.join(", ")})`;
        }
      }
    } catch (err) {
      reason = `error: ${err instanceof Error ? err.message : String(err)}`;
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
