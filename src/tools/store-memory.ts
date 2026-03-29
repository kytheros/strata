/**
 * store_memory MCP tool handler.
 * Allows Claude to explicitly store a memory/knowledge entry
 * that is immediately searchable via existing search tools.
 */

import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import type { IKnowledgeStore } from "../storage/interfaces/knowledge-store.js";
import type { KnowledgeEntry } from "../knowledge/knowledge-store.js";
import { getCachedGeminiProvider } from "../extensions/llm-extraction/gemini-provider.js";
import { resolveConflicts, executeResolution } from "../knowledge/conflict-resolver.js";
import { computeImportance } from "../knowledge/importance.js";
import { resolveGaps } from "../search/evidence-gaps.js";

import type { KnowledgeType } from "../knowledge/knowledge-store.js";

export interface StoreMemoryArgs {
  memory: string;
  type: KnowledgeType;
  tags?: string[];
  project?: string;
  user?: string;
}

/**
 * Handle the store_memory tool call.
 * Creates a KnowledgeEntry and writes it to the SQLite store.
 * When a Gemini provider is available, compresses the memory text via LLM.
 * Returns a confirmation message.
 */
export async function handleStoreMemory(
  knowledgeStore: IKnowledgeStore,
  args: StoreMemoryArgs,
  db?: Database.Database
): Promise<string> {
  const { memory, type, tags = [], project = "global", user } = args;

  if (!memory || memory.trim().length === 0) {
    return "Error: memory text is required.";
  }

  if (memory.trim().length < 5) {
    return "Error: memory text is too short (minimum 5 characters).";
  }

  const trimmed = memory.trim();
  let summary = trimmed.slice(0, 200);
  let details = trimmed;

  // Try LLM compression if provider is available
  const provider = await getCachedGeminiProvider();
  if (provider && trimmed.length > 100) {
    try {
      const compressed = await provider.complete(
        `Compress this ${type} into a concise 1-2 sentence summary. Preserve all key technical details, names, and decisions. Return ONLY the summary, no explanation.\n\n${trimmed}`,
        { maxTokens: 256, temperature: 0.1, timeoutMs: 5000 }
      );
      if (compressed && compressed.trim().length > 0) {
        summary = compressed.trim().slice(0, 200);
        details = trimmed; // Keep original as details
      }
    } catch {
      // Fall back to heuristic summary
    }
  }

  const entry: KnowledgeEntry = {
    id: randomUUID(),
    type,
    project,
    user,
    sessionId: "explicit-memory",
    timestamp: Date.now(),
    summary,
    details,
    tags,
    relatedFiles: [],
    extractedAt: Date.now(),
  };

  // Compute importance score before writing
  entry.importance = computeImportance({
    text: `${summary} ${details}`,
    sessionId: "explicit-memory",
    knowledgeType: type,
  });

  // Conflict resolution: resolve semantic conflicts before writing.
  // Falls back to direct addEntry when provider is null or on any error.
  const resolution = await resolveConflicts(entry, knowledgeStore, provider);
  executeResolution(resolution, entry, knowledgeStore);

  // Resolve any evidence gaps that match this new entry
  if (db) {
    try {
      resolveGaps(db, entry);
    } catch { /* gap resolution is best-effort */ }
  }

  const deletedCount = resolution.actions.filter((a) => a.action === "delete").length;
  const updatedCount = resolution.actions.filter((a) => a.action === "update").length;

  let suffix = "";
  if (deletedCount > 0 && updatedCount > 0) {
    suffix = ` (replaced ${deletedCount} conflicting, updated ${updatedCount} existing)`;
  } else if (deletedCount > 0) {
    suffix = ` (replaced ${deletedCount} conflicting entry${deletedCount > 1 ? "ies" : ""})`;
  } else if (updatedCount > 0) {
    suffix = ` (updated ${updatedCount} existing entry${updatedCount > 1 ? "ies" : ""})`;
  } else if (!resolution.shouldAdd) {
    return `Skipped duplicate ${type}: "${entry.summary}" (already exists)`;
  }

  return `Stored ${type}: "${entry.summary}"${tags.length > 0 ? ` [tags: ${tags.join(", ")}]` : ""}${suffix}`;
}
