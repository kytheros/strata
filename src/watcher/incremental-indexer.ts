/**
 * Incremental indexer: re-indexes only changed files.
 * Integrates with file watcher and knowledge extraction.
 * Uses ParserRegistry to route file changes to the correct parser.
 */

import { join, basename } from "path";
import { statSync } from "fs";
import { CONFIG } from "../config.js";
/** Minimal interface for index managers (works with both IndexManager and SqliteIndexManager). */
export interface IndexManagerLike {
  incrementalUpdate(): unknown;
  save?(): unknown;
}
import { parseSessionFile } from "../parsers/session-parser.js";
import type { SessionFileInfo, ParsedSession } from "../parsers/session-parser.js";
import { extractKnowledge } from "../knowledge/knowledge-extractor.js";
import type { KnowledgeEntry } from "../knowledge/knowledge-store.js";
import type { SynthesisStore } from "../knowledge/learning-synthesizer.js";

/** Minimal interface for knowledge stores used by the indexer. */
export interface IndexerKnowledgeStore extends SynthesisStore {
  save?(): unknown;
  getGlobalLearnings(project?: string): KnowledgeEntry[];
}
import {
  summarizeSession,
  cacheSummary,
} from "../knowledge/session-summarizer.js";
import { getCachedGeminiProvider } from "../extensions/llm-extraction/gemini-provider.js";
import { enhancedExtract } from "../extensions/llm-extraction/enhanced-extractor.js";
import { smartSummarize } from "../extensions/llm-extraction/smart-summarizer.js";
import { synthesizeLearnings } from "../knowledge/learning-synthesizer.js";
import { writeLearningsToMemory } from "../knowledge/memory-writer.js";
import { extractEntities, extractRelations } from "../knowledge/entity-extractor.js";
import { extractProcedures } from "../knowledge/procedure-extractor.js";
import { resolveConflicts, executeResolution } from "../knowledge/conflict-resolver.js";
import type { SqliteKnowledgeStore } from "../storage/sqlite-knowledge-store.js";
import type { SqliteEntityStore } from "../storage/sqlite-entity-store.js";
import type { ParserRegistry } from "../parsers/parser-registry.js";
import { randomUUID } from "crypto";
import { FileWatcher, getWatchTargets } from "./file-watcher.js";

export class IncrementalIndexer {
  private watcher: FileWatcher;
  private indexManager: IndexManagerLike;
  private knowledgeStore: IndexerKnowledgeStore;
  private entityStore: SqliteEntityStore | null;
  private parserRegistry: ParserRegistry | null;
  private processing = new Set<string>();

  constructor(
    indexManager: IndexManagerLike,
    knowledgeStore: IndexerKnowledgeStore,
    entityStore?: SqliteEntityStore,
    parserRegistry?: ParserRegistry
  ) {
    this.watcher = new FileWatcher();
    this.indexManager = indexManager;
    this.knowledgeStore = knowledgeStore;
    this.entityStore = entityStore ?? null;
    this.parserRegistry = parserRegistry ?? null;
  }

  /**
   * Start watching and auto-indexing.
   */
  start(): void {
    this.watcher.start((filename, parserId) => {
      this.handleFileChange(filename, parserId).catch(() => {});
    });
  }

  stop(): void {
    this.watcher.stop();
  }

  /**
   * Parse a session file using the appropriate parser.
   * For claude-code or when no registry is available, uses the legacy parseSessionFile().
   * For other parsers, constructs a SessionFileInfo and delegates to the parser.
   */
  private parseSession(filename: string, parserId: string): ParsedSession | null {
    // Claude Code path (legacy) — or fallback when no registry
    if (parserId === "claude-code" || !this.parserRegistry) {
      const parts = filename.replace(/\\/g, "/").split("/");
      if (parts.length < 2) return null;
      const projectDir = parts[0];
      const filePath = join(CONFIG.projectsDir, filename);
      return parseSessionFile(filePath, projectDir);
    }

    // Look up parser from registry
    const parser = this.parserRegistry.getById(parserId);
    if (!parser) return null;

    // Resolve the absolute file path using the watch target's directory
    const targets = getWatchTargets();
    const target = targets.find((t) => t.parserId === parserId);
    if (!target) return null;

    const filePath = join(target.dir, filename);

    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      return null;
    }

    // Construct SessionFileInfo for the parser
    const sessionId = basename(filename).replace(/\.[^.]+$/, "");
    const fileInfo: SessionFileInfo = {
      filePath,
      projectDir: basename(target.dir),
      sessionId,
      mtime: stat.mtimeMs,
      size: stat.size,
    };

    return parser.parse(fileInfo);
  }

  private async handleFileChange(filename: string, parserId: string): Promise<void> {
    const key = `${parserId}:${filename}`;
    if (this.processing.has(key)) return;
    this.processing.add(key);

    try {
      // Resolve the file path for staleness check
      let filePath: string;
      if (parserId === "claude-code" || !this.parserRegistry) {
        const parts = filename.replace(/\\/g, "/").split("/");
        if (parts.length < 2) return;
        filePath = join(CONFIG.projectsDir, filename);
      } else {
        const targets = getWatchTargets();
        const target = targets.find((t) => t.parserId === parserId);
        if (!target) return;
        filePath = join(target.dir, filename);
      }

      let stat;
      try {
        stat = statSync(filePath);
      } catch {
        return;
      }

      // Check if file hasn't been modified recently (session likely ended)
      const ageMinutes = (Date.now() - stat.mtimeMs) / 60000;
      if (ageMinutes < CONFIG.watcher.staleSessionMinutes) {
        // Still active, skip for now
        return;
      }

      // Re-index this file
      await this.indexManager.incrementalUpdate();
      if (this.indexManager.save) await this.indexManager.save();

      // Parse the session using the appropriate parser
      let session: ParsedSession | null;
      try {
        session = this.parseSession(filename, parserId);
      } catch {
        // Parser errors must not crash the pipeline
        return;
      }
      if (session) {
        const tool = session.tool || parserId;
        const projectDir = session.project;

        const provider = await getCachedGeminiProvider();
        const knowledge = provider
          ? await enhancedExtract(session, provider)
          : extractKnowledge(session);

        // Conflict resolution: when provider is available, resolve semantic conflicts
        // before writing. Falls back to direct addEntry when provider is null or on error.
        const sqliteStore = this.knowledgeStore as unknown as SqliteKnowledgeStore;
        for (const entry of knowledge) {
          if (provider && typeof sqliteStore.search === "function") {
            const resolution = await resolveConflicts(entry, sqliteStore, provider);
            executeResolution(resolution, entry, sqliteStore);
          } else {
            this.knowledgeStore.addEntry(entry);
          }
        }
        // Extract procedures (after knowledge extraction, runs independently)
        const procedures = extractProcedures(session);
        for (const proc of procedures) {
          if (provider && typeof sqliteStore.search === "function") {
            const resolution = await resolveConflicts(proc, sqliteStore, provider);
            executeResolution(resolution, proc, sqliteStore);
          } else {
            this.knowledgeStore.addEntry(proc);
          }
        }

        if (knowledge.length > 0 || procedures.length > 0) {
          this.knowledgeStore.save?.();

          // Extract and store entities (non-fatal)
          if (this.entityStore) {
            try {
              this.extractAndStoreEntities(knowledge, session.sessionId, projectDir);
            } catch (err) {
              // Entity extraction errors must never crash the pipeline
              console.warn("[entity-extraction] Error:", err);
            }
          }

          // Run synthesis after new knowledge is extracted
          const newLearnings = synthesizeLearnings(this.knowledgeStore);
          if (newLearnings.length > 0) {
            this.knowledgeStore.save?.();
            // Write learnings to the tool-appropriate location
            const projectLearnings =
              this.knowledgeStore.getGlobalLearnings(projectDir);
            writeLearningsToMemory(projectDir, projectLearnings, tool);
          }
        }

        // Cache summary
        const summary = provider
          ? await smartSummarize(session, provider)
          : summarizeSession(session);
        cacheSummary(summary);
      }
    } finally {
      this.processing.delete(key);
    }
  }

  /**
   * Extract entities from knowledge entries and store them in the entity store.
   * Links each entity to its source knowledge entry.
   */
  private extractAndStoreEntities(
    entries: import("../knowledge/knowledge-store.js").KnowledgeEntry[],
    sessionId: string,
    project: string
  ): void {
    if (!this.entityStore) return;
    const now = Date.now();

    for (const entry of entries) {
      const text = `${entry.summary} ${entry.details}`;
      const entities = extractEntities(text);

      const entityIds = new Map<string, string>();

      for (const extracted of entities) {
        const entityId = this.entityStore.upsertEntity({
          id: randomUUID(),
          name: extracted.name,
          type: extracted.type,
          canonicalName: extracted.canonicalName,
          aliases: [extracted.name.toLowerCase()],
          firstSeen: now,
          lastSeen: now,
          project,
        });
        entityIds.set(extracted.canonicalName, entityId);
        this.entityStore.linkToKnowledge(entry.id, entityId);
      }

      // Extract relations between entities in this entry
      const relations = extractRelations(text, entities);
      for (const rel of relations) {
        const sourceId = entityIds.get(rel.sourceCanonical);
        const targetId = entityIds.get(rel.targetCanonical);
        if (sourceId && targetId) {
          this.entityStore.addRelation({
            sourceEntityId: sourceId,
            targetEntityId: targetId,
            relationType: rel.relationType,
            context: rel.context,
            sessionId,
          });
        }
      }
    }
  }
}
