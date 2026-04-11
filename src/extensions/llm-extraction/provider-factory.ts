/**
 * Provider factory for LLM extraction and summarization.
 *
 * Reads the distillation config from ~/.strata/config.json and returns
 * the appropriate provider:
 *
 *   1. Hybrid (distillation enabled + Gemini key) -> local-first with frontier fallback
 *   2. Gemini (GEMINI_API_KEY set) -> frontier only
 *   3. null (no key) -> caller falls back to heuristic extraction
 */

import type { LlmProvider } from "./llm-provider.js";
import { getCachedGeminiProvider } from "./gemini-provider.js";
import { HybridProvider } from "./hybrid-provider.js";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface DistillationConfig {
  enabled: boolean;
  localUrl: string;
  extractionModel: string;
  summarizationModel: string;
  /**
   * Model used for conflict resolution (per-entry classify/delete/update).
   * Defaults to extractionModel if unset. A smaller variant (e.g. gemma4:e2b)
   * is recommended since conflict resolution is a short classification task.
   */
  conflictResolutionModel: string;
  fallback: string;
}

export function loadDistillConfig(): DistillationConfig | null {
  // Look in STRATA_DATA_DIR first (per-project override), then fall back to
  // the user-level ~/.strata/config.json. This lets benchmark harnesses and
  // isolated environments override STRATA_DATA_DIR for database isolation
  // while still picking up the user's local-inference preference from their
  // home directory.
  const primaryDataDir = process.env.STRATA_DATA_DIR || join(homedir(), ".strata");
  const primaryPath = join(primaryDataDir, "config.json");
  const homePath = join(homedir(), ".strata", "config.json");

  let configPath: string;
  if (existsSync(primaryPath)) {
    configPath = primaryPath;
  } else if (primaryPath !== homePath && existsSync(homePath)) {
    configPath = homePath;
  } else {
    return null;
  }

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    const d = raw?.distillation;
    if (!d?.enabled) return null;

    // Validate localUrl is loopback only (prevents SSRF via config injection)
    const localUrl = d.localUrl || "http://localhost:11434";
    try {
      const parsed = new URL(localUrl);
      const host = parsed.hostname.toLowerCase();
      if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
        console.warn(`[distillation] localUrl must be localhost, got '${host}' — ignoring, using default`);
        return {
          enabled: true,
          localUrl: "http://localhost:11434",
          extractionModel: d.extractionModel || "gemma4:e4b",
          summarizationModel: d.summarizationModel || "gemma4:e4b",
          conflictResolutionModel:
            d.conflictResolutionModel || d.extractionModel || "gemma4:e2b",
          fallback: d.fallback || "gemini",
        };
      }
    } catch {
      // Invalid URL — use default
    }

    return {
      enabled: true,
      localUrl,
      extractionModel: d.extractionModel || "gemma4:e4b",
      summarizationModel: d.summarizationModel || "gemma4:e4b",
      conflictResolutionModel:
        d.conflictResolutionModel || d.extractionModel || "gemma4:e2b",
      fallback: d.fallback || "gemini",
    };
  } catch {
    return null;
  }
}

/**
 * Strip markdown code fences from an LLM response before JSON parsing.
 *
 * Handles both ```json...``` and generic ```...``` wrappers with optional
 * leading/trailing whitespace. Returns the trimmed inner content, or the
 * original string if no fences are present.
 *
 * Why: Gemma 4, Gemini, and most chat-tuned models wrap JSON responses in
 * markdown code fences even when told "return ONLY valid JSON". Our
 * validators are used in HybridProvider's fallback decision, so rejecting
 * fence-wrapped output causes unnecessary frontier fallbacks and defeats
 * the whole point of local-first routing.
 */
function stripJsonFences(raw: string): string {
  const trimmed = raw.trim();
  // ```json\n{...}\n```  or  ```\n{...}\n```
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch) return fenceMatch[1].trim();
  return trimmed;
}

/**
 * Validate that a string is parseable JSON with an "entries" array (extraction output).
 * Handles markdown-wrapped JSON responses transparently.
 */
export function validateExtractionOutput(raw: string): boolean {
  try {
    const parsed = JSON.parse(stripJsonFences(raw));
    return Array.isArray(parsed?.entries);
  } catch {
    return false;
  }
}

/**
 * Validate that a string is parseable JSON with a "topic" string (summarization output).
 * Handles markdown-wrapped JSON responses transparently.
 */
export function validateSummarizationOutput(raw: string): boolean {
  try {
    const parsed = JSON.parse(stripJsonFences(raw));
    return typeof parsed?.topic === "string" && parsed.topic.length > 0;
  } catch {
    return false;
  }
}

/**
 * Validate that a string is parseable JSON matching the ConflictResolution
 * shape expected by strata/src/knowledge/conflict-resolver.ts:
 *   { shouldAdd: boolean, actions: Array<{ action: string, ... }> }
 * Handles markdown-wrapped JSON responses transparently.
 */
export function validateConflictResolutionOutput(raw: string): boolean {
  try {
    const parsed = JSON.parse(stripJsonFences(raw));
    if (typeof parsed?.shouldAdd !== "boolean") return false;
    if (!Array.isArray(parsed.actions)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the appropriate LLM provider for knowledge extraction.
 *
 * Priority:
 * 1. Hybrid (distillation enabled + GEMINI_API_KEY) -> local-first with frontier fallback
 * 2. Gemini (GEMINI_API_KEY set) -> frontier only
 * 3. null (no key) -> heuristic fallback in caller
 */
export async function getExtractionProvider(): Promise<LlmProvider | null> {
  const distillConfig = loadDistillConfig();
  const gemini = await getCachedGeminiProvider();

  if (distillConfig && gemini) {
    return new HybridProvider({
      localUrl: distillConfig.localUrl,
      localModel: distillConfig.extractionModel,
      frontierProvider: gemini,
      validateOutput: validateExtractionOutput,
      // 180s accommodates both Ollama cold starts (model load 20-45s) and
      // long extraction prompts on consumer GPUs. LongMemEval sessions with
      // 50+ turns produce 15K+ token prompts where prompt processing alone
      // takes 60-90s on an RTX 4060 Ti, plus up to 40s generation at 8192
      // num_predict. With OLLAMA_NUM_PARALLEL>1 the per-slot GPU bandwidth
      // is shared, pushing large prompts past the old 90s ceiling.
      localTimeoutMs: 180000,
    });
  }

  return gemini; // null if no GEMINI_API_KEY
}

/**
 * Get the appropriate LLM provider for session summarization.
 *
 * Priority:
 * 1. Hybrid (distillation enabled + GEMINI_API_KEY) -> local-first with frontier fallback
 * 2. Gemini (GEMINI_API_KEY set) -> frontier only
 * 3. null (no key) -> heuristic fallback in caller
 */
export async function getSummarizationProvider(): Promise<LlmProvider | null> {
  const distillConfig = loadDistillConfig();
  const gemini = await getCachedGeminiProvider();

  if (distillConfig && gemini) {
    return new HybridProvider({
      localUrl: distillConfig.localUrl,
      localModel: distillConfig.summarizationModel,
      frontierProvider: gemini,
      validateOutput: validateSummarizationOutput,
      // 90s — same cold-start tolerance as extraction.
      localTimeoutMs: 90000,
    });
  }

  return gemini;
}

/**
 * Get the LLM provider for conflict resolution (per-entry classify/delete/update).
 *
 * Priority:
 * 1. Hybrid (distillation enabled + GEMINI_API_KEY) -> local-first with frontier fallback
 *    — uses the smaller conflictResolutionModel (e.g. gemma4:e2b) for speed.
 * 2. Gemini (GEMINI_API_KEY set) -> frontier only
 * 3. null (no key) -> caller skips conflict resolution and direct-adds
 */
export async function getConflictResolutionProvider(): Promise<LlmProvider | null> {
  const distillConfig = loadDistillConfig();
  const gemini = await getCachedGeminiProvider();

  if (distillConfig && gemini) {
    return new HybridProvider({
      localUrl: distillConfig.localUrl,
      localModel: distillConfig.conflictResolutionModel,
      frontierProvider: gemini,
      validateOutput: validateConflictResolutionOutput,
      // 60s — classification is fast once warm, but e2b has its own cold-load
      // penalty since it's a different model from extraction/summarization.
      localTimeoutMs: 60000,
    });
  }

  return gemini;
}
