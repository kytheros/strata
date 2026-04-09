/**
 * Live HybridProvider regression test against a running Ollama daemon.
 *
 * This is the canary that locks in the 2026-04-09 Gemma 4 local-extraction
 * pipeline fixes (commits 161934f, 4509b26, 3856bf0). It exercises the
 * REAL strata-pro EXTRACTION_PROMPT and SUMMARIZER_PROMPT strings against
 * live Gemma 4 models through the HybridProvider + OllamaProvider stack,
 * and asserts that no validation-failure fallback warnings fire.
 *
 * Gating: the test is skipped unless
 *   1. Ollama is reachable at http://localhost:11434,
 *   2. gemma4:e4b and gemma4:e2b are pulled,
 *   3. ~/.strata/config.json contains a geminiApiKey (needed to construct
 *      HybridProvider, since it requires a frontier fallback provider).
 *
 * CI does not have Ollama or the real key, so the test is inert there.
 * Local runs during Gemma 4 pipeline work MUST execute this file —
 * a single fallback warning here is a red flag that the canary will
 * burn Gemini quota.
 *
 * DO NOT copy raw LLM output into static fixtures — Gemma's sampling is
 * stochastic, and this test derives value from calling the live daemon.
 */

import { describe, it, expect } from "vitest";
import {
  validateExtractionOutput,
  validateSummarizationOutput,
} from "../../../src/extensions/llm-extraction/provider-factory.js";

const OLLAMA_URL = "http://localhost:11434";

/**
 * Verbatim copy of strata-pro/src/ee/llm-extraction/enhanced-extractor.ts
 * EXTRACTION_PROMPT as of 2026-04-09. Kept in sync manually — if the
 * strata-pro prompt changes and this one does not, this test still catches
 * HybridProvider regressions but will be slightly stale as a prompt check.
 */
const EXTRACTION_PROMPT = `You are extracting durable memory about a USER from a conversation. The goal is to remember WHO THE USER IS — what they prefer, do, own, plan, believe, and care about — so a future assistant can give them personalized help.

PRIORITY ORDER (most important first):
1. USER statements about themselves: facts, preferences, decisions, current situation, history, goals.
2. USER statements about external entities they care about (people, places, things they own or use).
3. Assistant suggestions the USER explicitly accepted or committed to.
4. Patterns or workflows the USER described doing themselves.
5. Topics the USER is researching, exploring, or actively asking about (their interests, not the answers).

DO NOT EXTRACT:
- The assistant's recommendations the user did not respond to.
- The assistant's tutorials, bullet lists, or how-to explanations.
- The assistant's questions back to the user.
- Generic advice the assistant gave.
- The assistant's explanations dressed up as learnings. A learning entry captures what the USER is asking about or researching, NEVER the content of the assistant's answer.

The conversation is the USER teaching the assistant about themselves. Your job is to capture what the USER taught — not what the assistant already knew and explained back.

Session date: {session_date}

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "entries": [
    {
      "type": "fact|preference|decision|solution|error_fix|pattern|procedure|episodic|learning",
      "summary": "Concise description (under 120 chars), starting with 'User'",
      "details": "Optional elaboration with context",
      "tags": ["relevant", "tags"]
    }
  ]
}

Type definitions:
- "fact": Concrete personal information the USER stated about themselves or their world — names, places, possessions, relationships, occupations, skills, hobbies, quantities, current state.
- "preference": USER's opinions, likes, dislikes, habits, routines, personal choices. ALWAYS phrased as "User likes X", "User prefers Y".
- "decision": A choice the USER made between alternatives, even implicit ones.
- "episodic": An event, activity, or experience the USER described doing or experiencing.
- "solution": A problem the USER solved themselves. Include WHAT was wrong and HOW they fixed it.
- "error_fix": An error the USER hit, paired with the resolution.
- "pattern": A reusable approach the USER committed to or already uses.
- "procedure": A workflow the USER described doing themselves (steps in details: {"steps": [...]}). NOT the assistant's tutorials.
- "learning": A topic the USER is actively researching, exploring, or asking about in depth. Extract ONLY from USER turns — the learning signal is the user's expressed interest, NOT the assistant's explanation. Phrase as "User is researching X", "User is learning about Y", "User is exploring Z". NOT the assistant's content, even when the assistant is explaining something to the user.

Extraction rules:
- Maximum 30 entries. Extract every meaningful USER fact, not just the most important.
- AT LEAST 60% of entries MUST cite USER statements (start with "User").
- Each summary under 120 characters.
- Convert ALL relative dates to ABSOLUTE dates using the session date above. Examples: "last week" in a session dated 2023-05-15 → "the week of May 8, 2023"; "yesterday" → "May 14, 2023"; "three months ago" → "approximately February 2023". Always include the computed date in the summary.
- One atomic fact per entry — do NOT combine multiple facts.
- Resolve pronouns to the speaker they refer to.
- Do NOT extract trivial or generic information.

SELF-CHECK before returning: count your entries. If fewer than 60% start with "User" or otherwise cite a USER statement, drop assistant-derived entries until the ratio holds.

Session transcript:
`;

/**
 * Verbatim copy of strata-pro/src/ee/llm-extraction/smart-summarizer.ts
 * SUMMARIZER_PROMPT as of 2026-04-09.
 */
const SUMMARIZER_PROMPT = `You are analyzing a coding assistant conversation session. Extract structured knowledge from the conversation.

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "topic": "One sentence describing what this session was about",
  "keyDecisions": ["Decision 1", "Decision 2"],
  "solutionsFound": ["Solution 1", "Solution 2"],
  "patterns": ["Pattern 1"],
  "actionableLearnings": ["Learning 1", "Learning 2"]
}

Rules:
- topic: Brief (under 100 chars), specific description
- keyDecisions: Architectural or implementation choices made. Empty array if none.
- solutionsFound: Bugs fixed, problems solved. Include the problem and solution. Empty array if none.
- patterns: Reusable approaches or anti-patterns discovered. Empty array if none.
- actionableLearnings: Concrete takeaways someone could apply in future work. Empty array if none.
- Each array item should be a concise sentence (under 120 chars).
- Maximum 5 items per array.

Session transcript:
`;

/**
 * Verbatim smoke-test probe transcript from
 * benchmarks/longmemeval/run_retrieval_benchmark.py::_run_smoke_test
 * (2026-04-09). Using the exact strings the canary sends guarantees this
 * test fires on the same code path the benchmark exercises.
 */
const SMOKE_TRANSCRIPT =
  `[USER] My favorite color is purple and the secret token is smokeprobe1744213200xyzzy. I am testing the retrieval pipeline.\n` +
  `[ASSISTANT] Got it -- your favorite color is purple, and the token smokeprobe1744213200xyzzy is recorded for the smoke test.\n`;

async function ollamaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function loadGeminiKeyFromUserConfig(): Promise<string> {
  const fs = await import("fs");
  const path = await import("path");
  const os = await import("os");
  const configPath = path.join(os.homedir(), ".strata", "config.json");
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return typeof raw?.geminiApiKey === "string" ? raw.geminiApiKey : "";
  } catch {
    return "";
  }
}

describe("Gemma 4 HybridProvider canary (requires local Ollama + Gemini key)", () => {
  it("runs the real extraction + summarization prompts without falling back to Gemini", async () => {
    if (!(await ollamaReachable())) {
      console.warn(
        "[canary] Ollama not reachable at localhost:11434 — test skipped"
      );
      return;
    }

    const apiKey = await loadGeminiKeyFromUserConfig();
    if (!apiKey) {
      console.warn(
        "[canary] ~/.strata/config.json has no geminiApiKey — test skipped"
      );
      return;
    }

    const origKey = process.env.GEMINI_API_KEY;
    const origDataDir = process.env.STRATA_DATA_DIR;
    process.env.GEMINI_API_KEY = apiKey;
    // Ensure loadDistillConfig picks up the real ~/.strata/config.json
    // instead of whatever STRATA_DATA_DIR was set to by a previous test.
    delete process.env.STRATA_DATA_DIR;

    try {
      const { resetGeminiProviderCache } = await import(
        "../../../src/extensions/llm-extraction/gemini-provider.js"
      );
      resetGeminiProviderCache();

      const { getExtractionProvider, getSummarizationProvider } = await import(
        "../../../src/extensions/llm-extraction/provider-factory.js"
      );
      const { HybridProvider } = await import(
        "../../../src/extensions/llm-extraction/hybrid-provider.js"
      );

      const extractionProvider = await getExtractionProvider();
      expect(extractionProvider).not.toBeNull();
      expect(extractionProvider).toBeInstanceOf(HybridProvider);

      const summarizationProvider = await getSummarizationProvider();
      expect(summarizationProvider).not.toBeNull();
      expect(summarizationProvider).toBeInstanceOf(HybridProvider);

      // Capture HybridProvider's validation-failure warning. If this fires
      // even once, the canary will burn a Gemini quota call and the
      // local-first story is broken — the exact regression this test
      // guards against.
      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        const line = args.map((a) => String(a)).join(" ");
        warnings.push(line);
        origWarn.apply(console, args);
      };

      try {
        const extractionPrompt =
          EXTRACTION_PROMPT.replace("{session_date}", "2026-04-09") +
          SMOKE_TRANSCRIPT;

        // Match strata-pro's enhanced-extractor.ts call signature exactly.
        const extractionRaw = await extractionProvider!.complete(
          extractionPrompt,
          {
            maxTokens: 8192,
            temperature: 0.1,
            timeoutMs: 120000,
          }
        );
        expect(validateExtractionOutput(extractionRaw)).toBe(true);

        // Match strata-pro's smart-summarizer.ts call signature.
        const summaryRaw = await summarizationProvider!.complete(
          SUMMARIZER_PROMPT + SMOKE_TRANSCRIPT,
          {
            maxTokens: 4096,
            temperature: 0.1,
            timeoutMs: 30000,
          }
        );
        expect(validateSummarizationOutput(summaryRaw)).toBe(true);

        // Zero validation-fallback warnings is the whole point of the canary.
        const validationFallbacks = warnings.filter((w) =>
          w.includes("local model output failed validation")
        );
        expect(validationFallbacks).toHaveLength(0);
      } finally {
        console.warn = origWarn;
      }
    } finally {
      if (origKey !== undefined) {
        process.env.GEMINI_API_KEY = origKey;
      } else {
        delete process.env.GEMINI_API_KEY;
      }
      if (origDataDir !== undefined) {
        process.env.STRATA_DATA_DIR = origDataDir;
      }
    }
  }, 300000);
});
