/**
 * Semantic conflict resolution for the knowledge write path.
 *
 * Uses an LLM to classify the relationship between a candidate entry and
 * existing similar entries, producing ADD/UPDATE/DELETE/NOOP mutations.
 * Falls back to direct addEntry (existing trigram dedup) on any error.
 */

import type { KnowledgeEntry } from "./knowledge-store.js";
import type { IKnowledgeStore } from "../storage/interfaces/knowledge-store.js";
import type { LlmProvider } from "../extensions/llm-extraction/llm-provider.js";
import type Database from "better-sqlite3";
import { saveTrainingPair } from "../extensions/llm-extraction/training-capture.js";

/** Action to apply to an existing entry. */
export interface ConflictAction {
  id: string;
  action: "update" | "delete" | "noop";
  mergedSummary?: string;
  mergedDetails?: string;
}

/** Result of conflict resolution for a candidate entry. */
export interface ConflictResolution {
  shouldAdd: boolean;
  actions: ConflictAction[];
}

/** Safe fallback: add the candidate with no mutations. */
const FALLBACK_RESOLUTION: ConflictResolution = { shouldAdd: true, actions: [] };

/**
 * Resolve conflicts between a candidate entry and existing similar entries.
 *
 * Retrieves up to 5 similar entries via store.search(), sends a classification
 * prompt to the LLM, and returns a ConflictResolution describing mutations.
 *
 * When no provider is available, no similar entries exist, or the LLM call
 * fails, returns a safe fallback that results in a plain addEntry call.
 *
 * @param candidate - The new entry to evaluate
 * @param store - Knowledge store for searching and mutating entries
 * @param provider - Optional LLM provider; null means fallback mode
 * @param db - Optional database for training capture (Phase 0 distillation)
 * @returns ConflictResolution describing what mutations to apply
 */
export async function resolveConflicts(
  candidate: KnowledgeEntry,
  store: IKnowledgeStore,
  provider?: LlmProvider | null,
  db?: Database.Database
): Promise<ConflictResolution> {
  // Killswitch: STRATA_CONFLICT_RESOLUTION=0 disables conflict resolution
  if (process.env.STRATA_CONFLICT_RESOLUTION === "0") {
    return FALLBACK_RESOLUTION;
  }

  // No provider → fallback
  if (!provider) {
    return FALLBACK_RESOLUTION;
  }

  try {
    // Retrieve up to 5 similar entries
    const similar = (await store.search(candidate.summary)).slice(0, 5);

    // No similar entries → bypass LLM entirely (no unnecessary API call)
    if (similar.length === 0) {
      return FALLBACK_RESOLUTION;
    }

    const prompt = buildPrompt(candidate, similar);

    const raw = await provider.complete(prompt, {
      // 1024 provides headroom for multi-action responses with full UUIDs
      // and merged content. Previously 256, which fit Gemini's terse output
      // but truncated Gemma 4's fuller JSON under format:"json" mode,
      // producing invalid mid-JSON responses that failed validation and
      // triggered unnecessary frontier fallbacks. 1024 comfortably fits
      // 5-10 actions across realistic conflict scenarios.
      maxTokens: 1024,
      temperature: 0.1,
      timeoutMs: 8000,
    });

    const resolution = parseResponse(raw, similar);

    // Phase 0 distillation: capture (prompt, resolution) as a training pair.
    // Only fires when a db is provided — never throws (training capture must
    // never affect the primary resolution path).
    if (db) {
      try {
        saveTrainingPair(db, {
          taskType: "conflict",
          inputText: prompt,
          outputJson: JSON.stringify(resolution),
          modelUsed: provider.name,
          qualityScore: 1.0,
          heuristicDiverged: false,
        });
      } catch {
        // Training capture failure is silently swallowed — never block resolution
      }
    }

    return resolution;
  } catch {
    // Any error → fallback to direct addEntry (existing trigram dedup still fires)
    return FALLBACK_RESOLUTION;
  }
}

/**
 * Execute the mutations described by a ConflictResolution against the store.
 *
 * Order: deletes first, then updates, then add (if shouldAdd is true).
 * This ordering ensures superseded entries are removed before new ones land.
 *
 * @param resolution - The conflict resolution to execute
 * @param candidate - The candidate entry to potentially add
 * @param store - Knowledge store to mutate
 */
export async function executeResolution(
  resolution: ConflictResolution,
  candidate: KnowledgeEntry,
  store: IKnowledgeStore
): Promise<void> {
  // Deletes first
  for (const action of resolution.actions) {
    if (action.action === "delete") {
      await store.deleteEntry(action.id);
    }
  }

  // Updates second
  for (const action of resolution.actions) {
    if (action.action === "update") {
      await store.updateEntry(action.id, {
        summary: action.mergedSummary,
        details: action.mergedDetails,
      });
    }
  }

  // Add candidate last, only if shouldAdd is true
  if (resolution.shouldAdd) {
    await store.addEntry(candidate);
  }
}

/**
 * Build the classification prompt for the LLM.
 * Truncates entry text to 300 chars to prevent prompt bloat/injection.
 */
function buildPrompt(
  candidate: KnowledgeEntry,
  similar: KnowledgeEntry[]
): string {
  const truncate = (s: string, max = 300) =>
    s.length > max ? s.slice(0, max) + "..." : s;

  const existingFormatted = similar
    .map(
      (e, i) =>
        `${i + 1}. ID: ${e.id}\n   Type: ${e.type}\n   Summary: ${truncate(e.summary)}\n   Details: ${truncate(e.details)}`
    )
    .join("\n");

  return `You are a knowledge deduplication assistant. Given a NEW entry and EXISTING similar entries,
classify the relationship for each existing entry.

Return ONLY valid JSON, no markdown, no explanation:
{
  "shouldAdd": true | false,
  "actions": [
    { "id": "<existing-id>", "action": "delete" | "update" | "noop", "mergedSummary": "...", "mergedDetails": "..." }
  ]
}

Rules:
- "delete": the existing entry is superseded or directly contradicted by the new entry
- "update": the existing entry should be merged/refined with the new entry's information
- "noop": the existing entry is compatible, no change needed
- "shouldAdd": false only if the new entry is a trivial duplicate of an existing entry (no new info)
- For "update" actions, provide mergedSummary (required) and mergedDetails (optional)
- Ignore entries of different types unless they directly conflict

NEW ENTRY (type: ${candidate.type}):
Summary: ${truncate(candidate.summary)}
Details: ${truncate(candidate.details)}

EXISTING ENTRIES:
${existingFormatted}`;
}

/**
 * Parse and validate the LLM's JSON response into a ConflictResolution.
 * Strips markdown fences defensively. Validates action types and coerces
 * update actions missing mergedSummary to noop.
 */
export function parseResponse(
  raw: string,
  similar: KnowledgeEntry[]
): ConflictResolution {
  let cleaned = raw.trim();

  // Strip markdown code fences if present (defensive, mirrors enhanced-extractor pattern)
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON parse boundary
  const parsed = JSON.parse(cleaned) as any;

  // Validate shouldAdd
  const shouldAdd = typeof parsed.shouldAdd === "boolean" ? parsed.shouldAdd : true;

  // Validate actions array
  if (!Array.isArray(parsed.actions)) {
    return { shouldAdd, actions: [] };
  }

  const validActions = new Set(["update", "delete", "noop"]);
  const actions: ConflictAction[] = [];

  for (const raw of parsed.actions) {
    if (!raw || typeof raw.id !== "string" || !validActions.has(raw.action)) {
      continue; // Skip unknown or malformed actions
    }

    // Coerce update actions missing mergedSummary to noop
    if (raw.action === "update" && !raw.mergedSummary) {
      actions.push({ id: raw.id, action: "noop" });
      continue;
    }

    const action: ConflictAction = {
      id: raw.id,
      action: raw.action,
    };

    if (raw.action === "update") {
      action.mergedSummary = String(raw.mergedSummary);
      if (raw.mergedDetails) {
        action.mergedDetails = String(raw.mergedDetails);
      }
    }

    actions.push(action);
  }

  return { shouldAdd, actions };
}
