/**
 * Summarization quality eval.
 *
 * Loads fixtures/summarization-cases.json, runs each session through a
 * provider, and scores by topic keyword recall.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { LlmProvider } from "../../src/extensions/llm-extraction/llm-provider.js";
import type { EvalResult } from "./eval-extraction.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SummarizationFixture {
  id: string;
  session: {
    sessionId: string;
    project: string;
    messages: Array<{ role: string; text: string; timestamp: string }>;
  };
  expected_topic_keywords: string[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}

function buildPrompt(fixture: SummarizationFixture): string {
  const transcript = fixture.session.messages
    .map((m) => `${m.role.toUpperCase()}: ${m.text}`)
    .join("\n");
  return `Summarize this conversation as a topic. Return ONLY valid JSON:
{"topic":"short topic string"}

Conversation:
${transcript}`;
}

export async function evalSummarization(provider: LlmProvider): Promise<EvalResult> {
  const fixturesPath = join(__dirname, "fixtures", "summarization-cases.json");
  const fixtures: SummarizationFixture[] = JSON.parse(readFileSync(fixturesPath, "utf-8"));

  const latencies: number[] = [];
  const details: EvalResult["details"] = [];
  let passed = 0;

  for (const fixture of fixtures) {
    const prompt = buildPrompt(fixture);
    const start = Date.now();
    let pass = false;
    let reason = "";
    try {
      const raw = await provider.complete(prompt, {
        maxTokens: 1024,
        temperature: 0.1,
        timeoutMs: 30000,
      });
      const parsed = JSON.parse(raw);
      const topic = typeof parsed?.topic === "string" ? parsed.topic.toLowerCase() : "";
      if (!topic) {
        reason = "empty or missing topic";
      } else {
        const hit = fixture.expected_topic_keywords.some((kw) =>
          topic.includes(kw.toLowerCase())
        );
        if (hit) {
          pass = true;
          reason = "OK";
          passed += 1;
        } else {
          reason = `no expected keyword in topic (looked for: ${fixture.expected_topic_keywords.join(", ")})`;
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
