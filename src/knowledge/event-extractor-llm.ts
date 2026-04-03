/**
 * SVO event extraction using Gemini LLM.
 *
 * Extracts Subject-Verb-Object events from conversation session text.
 * Each event includes lexical aliases that bridge vocabulary gaps in retrieval.
 *
 * Production adaptation of benchmarks/longmemeval/extract-events.ts:
 * - Uses the existing GeminiProvider (src/extensions/llm-extraction/gemini-provider.ts)
 * - Accepts session text (string) instead of LongMemTurn arrays
 * - Returns SVOEvent[] from the event-store interface types
 * - No file caching (production stores in SQLite)
 */

import type { GeminiProvider } from "../extensions/llm-extraction/gemini-provider.js";
import type { SVOEvent } from "../storage/interfaces/event-store.js";
import { CONFIG } from "../config.js";

const SVO_EXTRACTION_PROMPT = `Extract all concrete EVENTS, ACTIVITIES, PURCHASES, and FACTS from this conversation as Subject-Verb-Object tuples.

For each event, return:
- "subject": Who did it (usually "User")
- "verb": The action (past tense: "bought", "attended", "visited", "cooked", "started")
- "object": What was acted upon, with specific names/numbers/places
- "startDate": When it happened (any format), or null
- "endDate": When it ended (if a period), or null
- "aliases": 2-3 rephrasings using COMPLETELY DIFFERENT vocabulary
- "category": One of: entertainment, work, health, purchase, social, travel, hobby, food, home, finance, fitness, personal, education, pet

Rules:
- Extract ACTIONS the user took, not general discussion topics
- Include quantities and specific names
- Include casual asides — these often contain key events
- One event per distinct action
- EVERY event MUST have subject, verb, AND object
- Aliases must use DIFFERENT words, not just rearrangements
- Maximum 15 events per conversation

Return ONLY valid JSON array:
[{"subject": "User", "verb": "bought", "object": "Tamiya 1/48 Spitfire model kit", "startDate": "August 2023", "endDate": null, "aliases": ["purchased a scale airplane model", "ordered a WWII fighter kit"], "category": "hobby"}]

If no events found, return: []

Conversation:
`;

/**
 * Extract SVO events from a session's text content.
 * Requires a GeminiProvider instance (caller manages the provider lifecycle).
 */
export async function extractSVOEvents(
  provider: GeminiProvider,
  sessionText: string,
  sessionId: string,
  project: string,
  timestamp: number
): Promise<SVOEvent[]> {
  if (!CONFIG.events.enabled) return [];

  // Truncate very long sessions to stay within token limits
  const truncated = sessionText.slice(0, 12000);
  const prompt = SVO_EXTRACTION_PROMPT + truncated;

  try {
    const response = await provider.complete(prompt, {
      maxTokens: 8000,
      temperature: 0,
      timeoutMs: 60000,
      jsonMode: true,
    });

    let cleaned = response.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    // Try parsing, with repair for truncated JSON arrays
    let parsed: unknown[];
    try {
      const raw = JSON.parse(cleaned);
      parsed = Array.isArray(raw) ? raw : [];
    } catch {
      // Attempt to salvage truncated JSON array — find all complete objects
      const objects: string[] = [];
      let depth = 0;
      let objStart = -1;
      for (let i = 0; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (ch === "{" && depth === 0) { objStart = i; depth = 1; }
        else if (ch === "{") { depth++; }
        else if (ch === "}" && depth > 1) { depth--; }
        else if (ch === "}" && depth === 1) { depth = 0; objects.push(cleaned.slice(objStart, i + 1)); }
        else if (ch === '"') { i++; while (i < cleaned.length && cleaned[i] !== '"') { if (cleaned[i] === "\\") i++; i++; } }
      }
      if (objects.length === 0) throw new Error("No complete SVO objects in response");
      parsed = objects.map((o) => JSON.parse(o));
    }

    return (parsed as Record<string, unknown>[])
      .filter(
        (e: Record<string, unknown>) => e.subject && e.verb && e.object
      )
      .map((e: Record<string, unknown>) => ({
        subject: String(e.subject || "User").slice(0, 100),
        verb: String(e.verb || "").slice(0, 100),
        object: String(e.object || "").slice(0, 300),
        startDate:
          (e.startDate as string) || (e.start_date as string) || null,
        endDate:
          (e.endDate as string) || (e.end_date as string) || null,
        aliases: Array.isArray(e.aliases)
          ? e.aliases
              .slice(0, CONFIG.events.aliasCount)
              .map((a: unknown) => String(a).slice(0, 200))
          : [],
        category: String(e.category || "personal"),
        sessionId,
        project,
        timestamp,
      }));
  } catch (err) {
    console.error(
      `[strata] SVO extraction failed for session ${sessionId}:`,
      err instanceof Error ? err.message : err
    );
    return [];
  }
}
