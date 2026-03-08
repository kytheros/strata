/**
 * SQLite-backed index manager.
 * Replaces the in-memory Map+msgpack IndexManager with SQLite persistence.
 * Uses the parser registry to discover and parse sessions from multiple tools.
 */

import type Database from "better-sqlite3";
import { openDatabase } from "../storage/database.js";
import { SqliteDocumentStore } from "../storage/sqlite-document-store.js";
import { SqliteKnowledgeStore } from "../storage/sqlite-knowledge-store.js";
import { SqliteSummaryStore } from "../storage/sqlite-summary-store.js";
import { SqliteMetaStore } from "../storage/sqlite-meta-store.js";
import { CONFIG } from "../config.js";
import { ParserRegistry } from "../parsers/parser-registry.js";
import { ClaudeCodeParser } from "../parsers/claude-code-parser.js";
import { CodexParser } from "../parsers/codex-parser.js";
import { ClineParser } from "../parsers/cline-parser.js";
import { GeminiParser } from "../parsers/gemini-parser.js";
import { AiderParser } from "../parsers/aider-parser.js";
import type { ConversationParser } from "../parsers/parser-interface.js";
import type { ParsedSession, SessionFileInfo } from "../parsers/session-parser.js";
import { hasFeature } from "../extensions/feature-gate.js";

export interface IndexMeta {
  lastIndexed: Record<string, number>;
  buildTime: number;
  version: number;
}

export class SqliteIndexManager {
  db: Database.Database;
  documents: SqliteDocumentStore;
  knowledge: SqliteKnowledgeStore;
  summaries: SqliteSummaryStore;
  meta: SqliteMetaStore;
  readonly registry: ParserRegistry;

  constructor(dbPath?: string) {
    this.db = openDatabase(dbPath);
    this.documents = new SqliteDocumentStore(this.db);
    this.knowledge = new SqliteKnowledgeStore(this.db);
    this.summaries = new SqliteSummaryStore(this.db);
    this.meta = new SqliteMetaStore(this.db);

    // Initialize parser registry with default parsers
    this.registry = new ParserRegistry();
    // Free tier: 3 parsers (Claude Code, Codex, Cline)
    this.registry.register(new ClaudeCodeParser());
    this.registry.register(new CodexParser());
    this.registry.register(new ClineParser());
    // Pro tier: additional parsers (Gemini CLI, Aider)
    if (hasFeature("pro")) {
      this.registry.register(new GeminiParser());
      this.registry.register(new AiderParser());
    }
  }

  /**
   * Build or rebuild the full index from scratch using all available parsers.
   */
  buildFullIndex(): { sessions: number; chunks: number } {
    const startTime = Date.now();
    const available = this.registry.detectAvailable();

    // Clear existing documents (within a transaction)
    this.db.exec("DELETE FROM documents");

    // Reset metadata
    this.meta.setJson("lastIndexed", {});
    this.meta.set("version", "1");

    let sessionCount = 0;
    const lastIndexed: Record<string, number> = {};

    // Batch insert within a transaction for performance
    const insertBatch = this.db.transaction(() => {
      for (const parser of available) {
        const files = parser.discover();
        for (const file of files) {
          this.indexFileWithParser(file, parser);
          lastIndexed[file.filePath] = file.mtime;
          sessionCount++;
        }
      }
    });

    insertBatch();

    const buildTime = Date.now() - startTime;
    this.meta.setJson("lastIndexed", lastIndexed);
    this.meta.set("buildTime", String(buildTime));

    return {
      sessions: sessionCount,
      chunks: this.documents.getDocumentCount(),
    };
  }

  /**
   * Incrementally update: only re-index files that changed since last index.
   * Uses all available parsers.
   */
  incrementalUpdate(): {
    added: number;
    updated: number;
    unchanged: number;
  } {
    const available = this.registry.detectAvailable();
    const lastIndexed = this.meta.getJson<Record<string, number>>("lastIndexed") || {};
    let added = 0;
    let updated = 0;
    let unchanged = 0;

    const updateBatch = this.db.transaction(() => {
      for (const parser of available) {
        const files = parser.discover();
        for (const file of files) {
          const lastMtime = lastIndexed[file.filePath];

          if (lastMtime === undefined) {
            this.indexFileWithParser(file, parser);
            lastIndexed[file.filePath] = file.mtime;
            added++;
          } else if (file.mtime > lastMtime) {
            this.documents.removeSession(file.sessionId);
            this.indexFileWithParser(file, parser);
            lastIndexed[file.filePath] = file.mtime;
            updated++;
          } else {
            unchanged++;
          }
        }
      }
    });

    updateBatch();
    this.meta.setJson("lastIndexed", lastIndexed);

    return { added, updated, unchanged };
  }

  /**
   * Index a single session file using a specific parser.
   */
  private indexFileWithParser(file: SessionFileInfo, parser: ConversationParser): void {
    const session = parser.parse(file);
    if (!session) return;

    const tool = session.tool || parser.id;
    const chunks = this.chunkSession(session);
    for (const chunk of chunks) {
      const tokenCount = chunk.text.split(/\s+/).length;
      this.documents.add(chunk.text, tokenCount, {
        sessionId: session.sessionId,
        project: session.project,
        role: chunk.role,
        timestamp: chunk.timestamp,
        toolNames: chunk.toolNames,
        messageIndex: chunk.messageIndex,
      }, tool);
    }
  }

  /**
   * Chunk a session into indexable pieces.
   * Strategy: group consecutive same-role messages, split long chunks.
   */
  private chunkSession(
    session: ParsedSession
  ): Array<{
    text: string;
    role: "user" | "assistant" | "mixed";
    timestamp: number;
    toolNames: string[];
    messageIndex: number;
  }> {
    const chunks: Array<{
      text: string;
      role: "user" | "assistant" | "mixed";
      timestamp: number;
      toolNames: string[];
      messageIndex: number;
    }> = [];

    const { chunkSize, maxChunksPerSession } = CONFIG.indexing;
    let currentText = "";
    let currentRole: "user" | "assistant" | "mixed" | null = null;
    let currentTimestamp = 0;
    let currentToolNames: string[] = [];
    let currentMessageIndex = 0;

    const flush = () => {
      if (currentText.trim() && currentRole) {
        const words = currentText.split(/\s+/);
        for (let i = 0; i < words.length; i += chunkSize) {
          if (chunks.length >= maxChunksPerSession) return;
          chunks.push({
            text: words.slice(i, i + chunkSize).join(" "),
            role: currentRole,
            timestamp: currentTimestamp,
            toolNames: [...currentToolNames],
            messageIndex: currentMessageIndex,
          });
        }
      }
      currentText = "";
      currentRole = null;
      currentToolNames = [];
    };

    for (let i = 0; i < session.messages.length; i++) {
      const msg = session.messages[i];

      if (currentRole && currentRole !== msg.role) {
        if (currentRole === "user" && msg.role === "assistant") {
          currentRole = "mixed";
        } else {
          flush();
        }
      }

      if (!currentRole) {
        currentRole = msg.role;
        currentTimestamp = msg.timestamp
          ? new Date(msg.timestamp).getTime() || 0
          : 0;
        currentMessageIndex = i;
      }

      currentText += (currentText ? "\n" : "") + msg.text;
      if (msg.toolNames.length > 0) {
        currentToolNames.push(...msg.toolNames);
      }
      if (msg.toolInputSnippets.length > 0) {
        currentText += " " + msg.toolInputSnippets.join(" ");
      }

      const wordCount = currentText.split(/\s+/).length;
      if (wordCount >= chunkSize * 1.5) {
        flush();
      }
    }

    flush();
    return chunks;
  }

  /**
   * Get index statistics.
   */
  getStats(): {
    documents: number;
    sessions: number;
    projects: number;
    buildTimeMs: number;
  } {
    return {
      documents: this.documents.getDocumentCount(),
      sessions: this.documents.getSessionIds().size,
      projects: this.documents.getProjects().size,
      buildTimeMs: parseInt(this.meta.get("buildTime") || "0", 10),
    };
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}
