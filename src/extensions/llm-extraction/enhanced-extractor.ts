/**
 * LLM-powered knowledge extraction.
 *
 * Catches implicit decisions, context-aware solutions, and patterns
 * that heuristic regex-based extraction misses.
 * Falls back to heuristic extraction on any LLM failure.
 *
 * Training data capture: after a successful LLM extraction, the
 * (prompt, output) pair is saved for local model distillation.
 */

import { randomUUID } from "crypto";
import type { ParsedSession } from "../../parsers/session-parser.js";
import type { KnowledgeEntry } from "../../knowledge/knowledge-store.js";
import { extractKnowledge } from "../../knowledge/knowledge-extractor.js";
import type { LlmProvider } from "./llm-provider.js";
import { saveTrainingPair } from "./training-capture.js";
import type Database from "better-sqlite3";

/** Raw extraction output from LLM */
interface LlmExtractionOutput {
  entries: Array<{
    type: "decision" | "solution" | "error_fix" | "pattern" | "procedure";
    summary: string;
    details?: string;
    tags?: string[];
    relatedFiles?: string[];
  }>;
}

const EXTRACTION_PROMPT = `You are analyzing a coding assistant conversation to extract knowledge entries. Find decisions, solutions, error fixes, and patterns — especially implicit ones that simple regex would miss.

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "entries": [
    {
      "type": "decision|solution|error_fix|pattern|procedure",
      "summary": "Concise description (under 120 chars)",
      "details": "Optional elaboration with context, or JSON for procedures",
      "tags": ["relevant", "technology", "tags"],
      "relatedFiles": ["/path/to/file.ts"]
    }
  ]
}

Extraction rules:
- "decision": Choices between alternatives, even implicit ones like "After trying X, Y worked better"
- "solution": Problems solved, bugs fixed. Include WHAT was wrong and HOW it was fixed.
- "error_fix": Error message paired with its resolution.
- "pattern": Reusable approaches, anti-patterns, or best practices discovered.
- "procedure": Sequential workflows, how-to guides, step-by-step processes. Extract steps as an ordered JSON array in the details field. Format: {"steps": ["step1", "step2", ...], "prerequisites": [...], "warnings": [...]}
- Maximum 10 entries total.
- Each summary under 120 characters.
- Focus on entries that regex pattern matching would MISS (implicit decisions, multi-turn context).
- Do NOT extract trivial file edits or routine operations.

Session transcript:
`;

/**
 * Extract knowledge using LLM analysis.
 *
 * Falls back to heuristic extraction on any LLM failure.
 *
 * @param session - Parsed session data
 * @param provider - LLM provider to use
 * @param db - Optional database for training data capture
 * @returns Knowledge entries conforming to KnowledgeEntry type
 */
export async function enhancedExtract(
  session: ParsedSession,
  provider: LlmProvider,
  db?: Database.Database
): Promise<KnowledgeEntry[]> {
  try {
    const transcript = formatTranscript(session);
    const prompt = EXTRACTION_PROMPT + transcript;

    const raw = await provider.complete(prompt, {
      maxTokens: 4096,
      temperature: 0.1,
      timeoutMs: 30000,
    });

    const parsed = parseExtractionResponse(raw);
    const entries = parsed.entries.map((e) => toKnowledgeEntry(e, session));

    // Merge with heuristic entries (LLM entries take priority, dedup by summary)
    const heuristicEntries = extractKnowledge(session);
    const merged = mergeEntries(entries, heuristicEntries);

    // Training data capture (Task 6) — NEVER affects primary path
    if (db && entries.length > 0) {
      try {
        const heuristicDiverged = heuristicEntries.length === 0 && entries.length > 0;
        saveTrainingPair(db, {
          taskType: "extraction",
          inputText: prompt,
          outputJson: raw,
          modelUsed: provider.name,
          qualityScore: 1.0,
          heuristicDiverged,
        });
      } catch (captureErr) {
        // Swallow — training capture must never affect extraction
        console.warn("[training-capture] extraction capture failed:", captureErr);
      }
    }

    return merged;
  } catch {
    // Fallback to heuristic extraction
    return extractKnowledge(session);
  }
}

/**
 * Format session messages into a compact transcript for the LLM.
 */
function formatTranscript(session: ParsedSession): string {
  const lines: string[] = [];
  let charBudget = 6000;

  for (const msg of session.messages) {
    if (charBudget <= 0) break;
    const prefix = msg.role === "user" ? "USER" : "ASSISTANT";
    const text = msg.text.slice(0, Math.min(msg.text.length, 400));
    const line = `[${prefix}] ${text}`;
    lines.push(line);
    charBudget -= line.length;
  }

  return lines.join("\n");
}

/**
 * Parse JSON from LLM response, handling markdown code fences and preamble text.
 * Includes repair for truncated JSON (common with token limits).
 */
function parseExtractionResponse(raw: string): LlmExtractionOutput {
  const cleaned = extractJson(raw);
  const parsed = parseWithRepair(cleaned) as LlmExtractionOutput;

  if (!Array.isArray(parsed.entries)) {
    throw new Error("Invalid extraction output: missing entries array");
  }

  // Validate and cap entries
  parsed.entries = parsed.entries
    .filter(
      (e) =>
        typeof e.type === "string" &&
        typeof e.summary === "string" &&
        ["decision", "solution", "error_fix", "pattern", "procedure"].includes(e.type)
    )
    .slice(0, 10);

  return parsed;
}

/**
 * Convert LLM extraction output to KnowledgeEntry.
 */
function toKnowledgeEntry(
  raw: LlmExtractionOutput["entries"][number],
  session: ParsedSession
): KnowledgeEntry {
  let details = raw.details || "";

  // For procedure type, ensure details is valid ProcedureDetails JSON
  if (raw.type === "procedure") {
    if (typeof details === "string") {
      try {
        const parsed = JSON.parse(details);
        if (!parsed || !Array.isArray(parsed.steps)) {
          // Wrap plain string as single-step procedure
          details = JSON.stringify({ steps: [details] });
        }
      } catch {
        // Plain string — wrap in steps array
        details = JSON.stringify({ steps: [details] });
      }
    }
  }

  return {
    id: randomUUID(),
    type: raw.type,
    project: session.project,
    sessionId: session.sessionId,
    timestamp: session.startTime,
    summary: raw.summary.slice(0, 120),
    details,
    tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 10) : [],
    relatedFiles: Array.isArray(raw.relatedFiles) ? raw.relatedFiles.slice(0, 5) : [],
  };
}

/**
 * Merge LLM entries with heuristic entries, deduplicating by summary similarity.
 * LLM entries take priority when summaries overlap.
 */
function mergeEntries(
  llmEntries: KnowledgeEntry[],
  heuristicEntries: KnowledgeEntry[]
): KnowledgeEntry[] {
  const seen = new Set<string>();
  const result: KnowledgeEntry[] = [];

  // Add LLM entries first (priority)
  for (const entry of llmEntries) {
    const key = normalizeKey(entry.summary);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(entry);
    }
  }

  // Add heuristic entries that don't overlap
  for (const entry of heuristicEntries) {
    const key = normalizeKey(entry.summary);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(entry);
    }
  }

  return result;
}

/**
 * Normalize a summary string for dedup comparison.
 */
function normalizeKey(summary: string): string {
  return summary.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 60);
}

/**
 * Try to parse JSON, repairing truncated responses by closing open structures.
 * LLMs often hit token limits mid-JSON, producing valid entries followed by truncation.
 */
function parseWithRepair(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    // Try to salvage truncated JSON by finding last complete entry in the entries array
    // Look for the last complete object boundary "}" followed by a comma or whitespace
    const entriesMatch = json.match(/"entries"\s*:\s*\[/);
    if (!entriesMatch) throw new Error("No entries array found in response");

    const arrayStart = json.indexOf("[", entriesMatch.index!);
    // Find all complete objects by matching balanced braces
    const objects: string[] = [];
    let depth = 0;
    let objStart = -1;

    for (let i = arrayStart + 1; i < json.length; i++) {
      const ch = json[i];
      if (ch === "{" && depth === 0) {
        objStart = i;
        depth = 1;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}" && depth > 1) {
        depth--;
      } else if (ch === "}" && depth === 1) {
        depth = 0;
        objects.push(json.slice(objStart, i + 1));
      } else if (ch === '"') {
        // Skip string contents (handle escapes)
        i++;
        while (i < json.length && json[i] !== '"') {
          if (json[i] === "\\") i++; // skip escaped char
          i++;
        }
      }
    }

    if (objects.length === 0) throw new Error("No complete entries in truncated response");

    const repaired = `{"entries": [${objects.join(",")}]}`;
    return JSON.parse(repaired);
  }
}

/**
 * Extract JSON from LLM response, handling markdown fences and preamble text.
 * Gemini 2.5+ models may include thinking/reasoning text before the JSON.
 */
function extractJson(raw: string): string {
  let text = raw.trim();

  // Strip markdown code fences
  if (text.includes("```")) {
    const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenced) return fenced[1].trim();
  }

  // Try parsing directly first
  if (text.startsWith("{") || text.startsWith("[")) {
    return text;
  }

  // Find first { and last } to extract embedded JSON
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }

  return text;
}
