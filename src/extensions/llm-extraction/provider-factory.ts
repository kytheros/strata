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
  const dataDir = process.env.STRATA_DATA_DIR || join(homedir(), ".strata");
  const configPath = join(dataDir, "config.json");

  if (!existsSync(configPath)) return null;

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
 * Validate that a string is parseable JSON with an "entries" array (extraction output).
 */
export function validateExtractionOutput(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.entries);
  } catch {
    return false;
  }
}

/**
 * Validate that a string is parseable JSON with a "topic" string (summarization output).
 */
export function validateSummarizationOutput(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.topic === "string" && parsed.topic.length > 0;
  } catch {
    return false;
  }
}

/**
 * Validate that a string is parseable JSON matching the ConflictResolution
 * shape expected by strata/src/knowledge/conflict-resolver.ts:
 *   { shouldAdd: boolean, actions: Array<{ action: string, ... }> }
 */
export function validateConflictResolutionOutput(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw);
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
      localTimeoutMs: 15000,
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
      localTimeoutMs: 15000,
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
      localTimeoutMs: 10000, // Shorter than extraction: classification is fast
    });
  }

  return gemini;
}
