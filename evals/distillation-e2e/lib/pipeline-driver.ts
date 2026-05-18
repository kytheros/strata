/**
 * pipeline-driver.ts — Phase 7.2 T7/T8
 *
 * Drives a Fixture's sessions through the real production extraction pipeline:
 *   extractAtomicFacts() → applyHedgeFilter() → storage.knowledge.addEntry()
 *
 * Design decisions (stored in Strata memory):
 *
 * 1. Uses the extraction functions directly rather than ExtractionWorker/queue.
 *    ExtractionWorker lives in rest-transport.ts only and is NOT on CreateServerResult.
 *    The queue is an async delivery mechanism; the extraction logic is the same either way.
 *
 * 2. Cache replay (T8): on cache hit, calls storage.knowledge.addEntry() with the
 *    pre-computed fact text, bypassing the LLM entirely. This is the trivial path —
 *    no new ExtractionWorker API needed.
 *
 * 3. Each session turn is extracted separately. Only non-empty user turns are
 *    extracted (mirrors the REST /store handler behavior).
 */

import { randomUUID } from "node:crypto";
import type { IsolatedHandle } from "./isolated-db.js";
import type { Fixture, FixtureSession, FixtureTurn } from "./fixture-types.js";
import { cacheKeyFor, readCache, writeCache } from "./cache.js";
import { resolveProvider } from "./integrity-gate.js";

export interface PipelineResult {
  factsWritten: number;
  sessionsProcessed: number;
  cacheHits: number;
  /**
   * Number of raw turns written to knowledge_turns (T9.5). This is the
   * source of truth for harness retrieval — extraction quality no longer
   * gates whether the harness can measure recall/answer correctness.
   */
  turnsWritten: number;
}

export interface DrivePipelineOptions {
  /** If provided, extraction results are cached under this root directory. */
  cacheRoot?: string;
  /**
   * The prompt template string used for cache key derivation.
   * Pass the actual extraction prompt template content to bust the cache
   * automatically when the prompt changes. Defaults to "" (no prompt hash).
   */
  extractionPromptTemplate?: string;
  /**
   * If true, skip the extraction → knowledge_entries lane entirely. Turns are
   * still written to knowledge_turns (T9.5), which is the harness's source of
   * truth for retrieval. Use this when extraction quality is not what's being
   * measured (e.g. T17 baseline runs) — saves an LLM call per turn.
   * Default false to preserve existing test behavior.
   */
  skipExtraction?: boolean;
}

/**
 * Drives a Fixture through real extraction → real KnowledgeStore.
 * NO ExtractionWorker dependency — uses extractAtomicFacts() directly,
 * which is the same logic the REST transport uses after dequeuing.
 */
export async function drivePipeline(
  handle: IsolatedHandle,
  fixture: Fixture,
  options: DrivePipelineOptions = {}
): Promise<PipelineResult> {
  const skipExtraction = options.skipExtraction ?? false;
  const resolvedProvider = resolveProvider();

  // Lazy imports — these are production extraction modules, not re-implementations.
  // Skipped when skipExtraction=true since they're not needed for the turn lane.
  const extractionModules = skipExtraction
    ? null
    : {
        extractAtomicFacts: (await import("../../../src/extensions/llm-extraction/utterance-extractor.js")).extractAtomicFacts,
        applyHedgeFilter: (await import("../../../src/extensions/llm-extraction/hedge-filter.js")).applyHedgeFilter,
      };

  // Build the extraction provider directly from resolveProvider() so the
  // harness honors STRATA_EXTRACTION_PROVIDER (gemini | ollama:<model> | hybrid).
  // getExtractionProvider() would auto-pick HybridProvider when distillation
  // is configured in ~/.strata/config.json, contaminating "Gemini-only" runs.
  let provider: import("../../../src/extensions/llm-extraction/llm-provider.js").LlmProvider | null = null;
  if (!skipExtraction) {
    if (resolvedProvider.kind === "gemini") {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("GEMINI_API_KEY required for STRATA_EXTRACTION_PROVIDER=gemini");
      const { GeminiProvider } = await import("../../../src/extensions/llm-extraction/gemini-provider.js");
      provider = new GeminiProvider({ apiKey });
    } else if (resolvedProvider.kind === "ollama") {
      const { OllamaProvider } = await import("../../../src/extensions/llm-extraction/llm-provider.js");
      provider = new OllamaProvider(resolvedProvider.model);
    } else {
      // hybrid — fall back to the auto-selected provider
      const { getExtractionProvider } = await import("../../../src/extensions/llm-extraction/provider-factory.js");
      provider = await getExtractionProvider();
    }
    if (!provider) {
      throw new Error(
        "No extraction provider available — ensure GEMINI_API_KEY is set or STRATA_EXTRACTION_PROVIDER points to a running Ollama instance."
      );
    }
  }

  const providerKey = resolvedProvider.kind === "ollama"
    ? `ollama:${resolvedProvider.model}`
    : resolvedProvider.kind;
  const modelVersion = resolvedProvider.kind === "ollama"
    ? resolvedProvider.model
    : "gemini-2.5-flash";
  const promptTemplate = options.extractionPromptTemplate ?? "";
  const cacheRoot = options.cacheRoot;

  let factsWritten = 0;
  let cacheHits = 0;
  let turnsWritten = 0;

  for (const session of fixture.sessions) {
    // T9.5: write every turn to knowledge_turns FIRST, before extraction.
    // This is the lane query-runner queries — extraction success is a
    // separate quality concern, not a correctness gate.
    for (let msgIdx = 0; msgIdx < session.turns.length; msgIdx++) {
      const turn = session.turns[msgIdx];
      const content = turn.content.trim();
      if (!content) continue;
      await handle.knowledgeTurn.insert({
        sessionId: session.id,
        project: `e2e-${fixture.id}`,
        userId: null,
        speaker: turn.role,
        content,
        messageIndex: msgIdx,
      });
      turnsWritten++;
    }

    if (skipExtraction) continue;

    const sessionContent = JSON.stringify(session);

    if (cacheRoot) {
      const key = cacheKeyFor({
        provider: providerKey,
        modelVersion,
        promptTemplate,
        sessionContent,
      });
      const hit = readCache<{ facts: Array<{ text: string; type: string }> }>(cacheRoot, key);
      if (hit && Array.isArray(hit.facts)) {
        // Cache hit: replay precomputed facts directly into knowledge store.
        // This is the trivial path — no new ExtractionWorker API needed.
        for (const f of hit.facts) {
          await handle.server.storage.knowledge.addEntry({
            id: randomUUID(),
            type: (f.type === "episodic" ? "episodic" : "learning"),
            project: `e2e-${fixture.id}`,
            sessionId: session.id,
            timestamp: Date.now(),
            summary: f.text,
            details: f.text,
            tags: ["extracted", "e2e-harness", "cache-replay"],
            relatedFiles: [],
          });
          factsWritten++;
        }
        cacheHits++;
        continue;
      }

      // Cache miss: run real extraction, then cache and store.
      const extractedFacts = await extractSessionFacts(session, provider!, extractionModules!.extractAtomicFacts, extractionModules!.applyHedgeFilter);
      writeCache(cacheRoot, key, { facts: extractedFacts.map(f => ({ text: f.text, type: f.type })) });

      for (const f of extractedFacts) {
        await handle.server.storage.knowledge.addEntry({
          id: randomUUID(),
          type: (f.type === "episodic" ? "episodic" : "learning"),
          project: `e2e-${fixture.id}`,
          sessionId: session.id,
          timestamp: Date.now(),
          summary: f.text,
          details: f.text,
          tags: ["extracted", "e2e-harness"],
          relatedFiles: [],
        });
        factsWritten++;
      }
    } else {
      // No cache: run real extraction and store directly.
      const extractedFacts = await extractSessionFacts(session, provider!, extractionModules!.extractAtomicFacts, extractionModules!.applyHedgeFilter);

      for (const f of extractedFacts) {
        await handle.server.storage.knowledge.addEntry({
          id: randomUUID(),
          type: (f.type === "episodic" ? "episodic" : "learning"),
          project: `e2e-${fixture.id}`,
          sessionId: session.id,
          timestamp: Date.now(),
          summary: f.text,
          details: f.text,
          tags: ["extracted", "e2e-harness"],
          relatedFiles: [],
        });
        factsWritten++;
      }
    }
  }

  return { factsWritten, sessionsProcessed: fixture.sessions.length, cacheHits, turnsWritten };
}

/**
 * Extract atomic facts from all turns in a session using the real production extractor.
 * Mirrors the REST /store handler's extraction pass:
 * - Each turn's content is extracted separately.
 * - Hedge filter is applied after extraction.
 * - Only turns with non-empty content are processed.
 */
async function extractSessionFacts(
  session: FixtureSession,
  provider: import("../../../src/extensions/llm-extraction/llm-provider.js").LlmProvider,
  extractAtomicFacts: (text: string, opts: { provider: typeof provider; timeoutMs?: number; maxItems?: number; maxTokens?: number; retryOnParseFail?: number }) => Promise<import("../../../src/extensions/llm-extraction/utterance-extractor.js").AtomicFact[]>,
  applyHedgeFilter: (facts: import("../../../src/extensions/llm-extraction/utterance-extractor.js").AtomicFact[], source: string) => import("../../../src/extensions/llm-extraction/utterance-extractor.js").AtomicFact[]
): Promise<import("../../../src/extensions/llm-extraction/utterance-extractor.js").AtomicFact[]> {
  const allFacts: import("../../../src/extensions/llm-extraction/utterance-extractor.js").AtomicFact[] = [];

  for (const turn of session.turns) {
    const content = turn.content.trim();
    if (!content) continue;
    try {
      // Settings mirror benchmarks/longmemeval/extract-events.ts:240-246, which
      // is the production LongMemEval ingestion path that already handles long
      // conversational content reliably. 60s timeout + retry on parse fail
      // brings the harness from 30-50% extraction failure on LME prose down
      // to <5%.
      const raw = await extractAtomicFacts(content, {
        provider,
        maxItems: 5,
        maxTokens: 2048,
        timeoutMs: 60_000,
        retryOnParseFail: 1,
      });
      const filtered = applyHedgeFilter(raw, content);
      allFacts.push(...filtered);
    } catch (e) {
      // Tolerate per-turn extraction failures — the session continues — but
      // log so silent zero-fact extraction doesn't masquerade as a healthy run.
      process.stderr.write(
        `[pipeline-driver] extraction failed for session=${session.id} turn-content="${content.slice(0, 80)}…": ${(e as Error).message}\n`
      );
    }
  }

  return allFacts;
}
