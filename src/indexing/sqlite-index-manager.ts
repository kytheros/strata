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

    // Reset metadata — these are sync under the hood (SQLite adapter)
    void this.meta.setJson("lastIndexed", {});
    void this.meta.set("version", "1");

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
    void this.meta.setJson("lastIndexed", lastIndexed);
    void this.meta.set("buildTime", String(buildTime));

    // getDocumentCount() is async but resolves synchronously in SQLite adapter.
    // Access the underlying sync count for the return value.
    const countRow = this.db.prepare("SELECT COUNT(*) as count FROM documents").get() as { count: number };

    return {
      sessions: sessionCount,
      chunks: countRow.count,
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
    // Read lastIndexed synchronously from the SQLite database directly
    const lastIndexedRaw = this.db.prepare("SELECT value FROM index_meta WHERE key = ?").get("lastIndexed") as { value: string } | undefined;
    const lastIndexed: Record<string, number> = lastIndexedRaw ? JSON.parse(lastIndexedRaw.value) : {};
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
            // removeSession is async but executes synchronously in SQLite adapter
            void this.documents.removeSession(file.sessionId);
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
    void this.meta.setJson("lastIndexed", lastIndexed);

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
      // add() is async but executes synchronously in SQLite adapter; return value not needed here
      void this.documents.add(chunk.text, tokenCount, {
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

    const { chunkSize, chunkOverlap, maxChunksPerSession } = CONFIG.indexing;
    let currentText = "";
    let currentRole: "user" | "assistant" | "mixed" | null = null;
    let currentTimestamp = 0;
    let currentToolNames: string[] = [];
    let currentMessageIndex = 0;
    // Tail words from the previous flush, prepended to the next chunk for cross-boundary overlap
    let overlapTail = "";

    const flush = () => {
      if (currentText.trim() && currentRole) {
        const words = currentText.split(/\s+/).filter(Boolean);
        // Cross-flush overlap prefix: last N words of the previous chunk.
        // Prepended only to the first sub-chunk so it doesn't inflate the
        // accumulated text length and cause spurious extra sub-chunks.
        const prefixWords = overlapTail ? overlapTail.split(/\s+/).filter(Boolean) : [];

        for (let i = 0; i < words.length; i += chunkSize) {
          if (chunks.length >= maxChunksPerSession) break;

          let chunkText: string;
          if (i === 0 && prefixWords.length > 0) {
            // First sub-chunk: prepend cross-flush overlap
            chunkText = [...prefixWords, ...words.slice(0, chunkSize)].join(" ");
          } else if (i > 0 && chunkOverlap > 0) {
            // Non-first sub-chunks: apply within-flush overlap by backing up start
            const start = Math.max(0, i - chunkOverlap);
            chunkText = words.slice(start, i + chunkSize).join(" ");
          } else {
            chunkText = words.slice(i, i + chunkSize).join(" ");
          }

          chunks.push({
            text: chunkText,
            role: currentRole,
            timestamp: currentTimestamp,
            toolNames: [...currentToolNames],
            messageIndex: currentMessageIndex,
          });
        }

        // Save tail for the next flush's cross-flush overlap
        overlapTail = chunkOverlap > 0
          ? words.slice(Math.max(0, words.length - chunkOverlap)).join(" ")
          : "";
      } else {
        overlapTail = "";
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
    // Access SQLite directly for synchronous stats (IndexManager is always SQLite-backed)
    const docCount = this.db.prepare("SELECT COUNT(*) as count FROM documents").get() as { count: number };
    const sessionRows = this.db.prepare("SELECT DISTINCT session_id FROM documents").all() as { session_id: string }[];
    const projectRows = this.db.prepare("SELECT DISTINCT project FROM documents").all() as { project: string }[];
    const buildTimeRow = this.db.prepare("SELECT value FROM index_meta WHERE key = ?").get("buildTime") as { value: string } | undefined;

    return {
      documents: docCount.count,
      sessions: sessionRows.length,
      projects: projectRows.length,
      buildTimeMs: parseInt(buildTimeRow?.value || "0", 10),
    };
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}
