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
  // Lazy imports — these are production extraction modules, not re-implementations.
  const { getExtractionProvider } = await import("../../../src/extensions/llm-extraction/provider-factory.js");
  const { extractAtomicFacts } = await import("../../../src/extensions/llm-extraction/utterance-extractor.js");
  const { applyHedgeFilter } = await import("../../../src/extensions/llm-extraction/hedge-filter.js");

  const provider = await getExtractionProvider();
  if (!provider) {
    throw new Error(
      "No extraction provider available — ensure GEMINI_API_KEY is set or STRATA_EXTRACTION_PROVIDER points to a running Ollama instance."
    );
  }

  const resolvedProvider = resolveProvider();
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

  for (const session of fixture.sessions) {
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
      const extractedFacts = await extractSessionFacts(session, provider, extractAtomicFacts, applyHedgeFilter);
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
      const extractedFacts = await extractSessionFacts(session, provider, extractAtomicFacts, applyHedgeFilter);

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

  return { factsWritten, sessionsProcessed: fixture.sessions.length, cacheHits };
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
  extractAtomicFacts: (text: string, opts: { provider: typeof provider; timeoutMs?: number; maxItems?: number }) => Promise<import("../../../src/extensions/llm-extraction/utterance-extractor.js").AtomicFact[]>,
  applyHedgeFilter: (facts: import("../../../src/extensions/llm-extraction/utterance-extractor.js").AtomicFact[], source: string) => import("../../../src/extensions/llm-extraction/utterance-extractor.js").AtomicFact[]
): Promise<import("../../../src/extensions/llm-extraction/utterance-extractor.js").AtomicFact[]> {
  const allFacts: import("../../../src/extensions/llm-extraction/utterance-extractor.js").AtomicFact[] = [];

  for (const turn of session.turns) {
    const content = turn.content.trim();
    if (!content) continue;
    try {
      const raw = await extractAtomicFacts(content, { provider, maxItems: 5 });
      const filtered = applyHedgeFilter(raw, content);
      allFacts.push(...filtered);
    } catch {
      // Tolerate per-turn extraction failures — the session continues.
    }
  }

  return allFacts;
}
