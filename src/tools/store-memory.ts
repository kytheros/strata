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
import { extractEntities } from "../knowledge/entity-extractor.js";
import type { IEntityStore } from "../storage/interfaces/entity-store.js";
import type { DocumentChunkStore, DocumentChunk as StoredChunk } from "../storage/document-chunk-store.js";
import type { DocumentEmbedder } from "../extensions/embeddings/document-embedder.js";
import { chunkText } from "./store-document.js";
import { CONFIG } from "../config.js";

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
 * When an entityStore is provided, extracts entities from the memory text and
 * writes knowledge_entities junction rows linking the entry to each entity.
 * Returns a confirmation message.
 */
export async function handleStoreMemory(
  knowledgeStore: IKnowledgeStore,
  args: StoreMemoryArgs,
  db?: Database.Database,
  entityStore?: IEntityStore,
  documentChunkStore?: DocumentChunkStore,
  documentEmbedder?: DocumentEmbedder
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
  await executeResolution(resolution, entry, knowledgeStore);

  // Resolve any evidence gaps that match this new entry
  if (db) {
    try {
      resolveGaps(db, entry);
    } catch { /* gap resolution is best-effort */ }
  }

  // Entity extraction: link the written entry to any entities found in its text.
  // Only runs when an entityStore is provided (opt-in, D3-compliant).
  // Errors are non-fatal — entity linking must never block memory storage.
  if (entityStore && resolution.shouldAdd) {
    const text = `${summary} ${details}`;
    const entities = extractEntities(text);
    const now = Date.now();
    for (const extracted of entities) {
      try {
        const entityId = await entityStore.upsertEntity({
          id: randomUUID(),
          name: extracted.name,
          type: extracted.type,
          canonicalName: extracted.canonicalName,
          aliases: [extracted.name.toLowerCase()],
          firstSeen: now,
          lastSeen: now,
          project: entry.project,
        });
        await entityStore.linkToKnowledge(entry.id, entityId);
      } catch {
        // Entity linking errors must never block storage
      }
    }
  }

  // Shadow chunk-indexing: when details exceed the threshold, also store the
  // details into DocumentChunkStore for FTS5/vector chunk-granularity retrieval.
  // The atomic knowledge entry above is the canonical record; this is additive.
  // No-op when documentChunkStore is absent (e.g. no local DB) — D3-compliant.
  if (
    documentChunkStore &&
    documentEmbedder &&
    resolution.shouldAdd &&
    details.length > CONFIG.indexing.storeMemoryChunkThreshold
  ) {
    try {
      const docId = randomUUID();
      const now = Date.now();
      const textChunks = chunkText(details, CONFIG.indexing.chunkSize, CONFIG.indexing.chunkOverlap);
      const chunks: StoredChunk[] = [];

      for (let i = 0; i < textChunks.length; i++) {
        let embedding: Float32Array;
        try {
          embedding = await documentEmbedder.embedText(textChunks[i]);
        } catch {
          // Embedding failure is best-effort — store with a zero vector so FTS5
          // still indexes the chunk text even if vector search cannot use it.
          embedding = new Float32Array(CONFIG.quantization.embeddingDim);
        }
        chunks.push({
          id: randomUUID(),
          documentId: docId,
          chunkIndex: i,
          content: textChunks[i],
          embedding,
          model: CONFIG.embeddings.documentModel,
          tokenCount: Math.ceil(textChunks[i].length / 4),
          createdAt: now,
        });
      }

      if (chunks.length > 0) {
        const derivedSessionId = `explicit-memory:${entry.id}`;
        documentChunkStore.addDocument(
          {
            id: docId,
            title: derivedSessionId,
            mimeType: "text/plain",
            project: entry.project,
            user: entry.user,
            tags: entry.tags,
            chunkCount: chunks.length,
            fileSize: details.length,
            createdAt: now,
          },
          chunks
        );
      }
    } catch {
      // Shadow indexing is best-effort — must never block or surface errors
    }
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
