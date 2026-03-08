/**
 * Real-time watcher for active Claude Code session JSONL files.
 * Uses fs.watch with 5s debounce to detect new lines, then runs
 * incremental parsing and heuristic knowledge extraction.
 */

import { watch, existsSync, statSync, type FSWatcher } from "fs";
import { basename, dirname } from "path";
import { parsePartial, type SessionMessage } from "../parsers/session-parser.js";
import { extractKnowledge } from "../knowledge/knowledge-extractor.js";
import { SqliteKnowledgeStore } from "../storage/sqlite-knowledge-store.js";
import type { ParsedSession } from "../parsers/session-parser.js";

export interface RealtimeWatcherOptions {
  /** Debounce interval in milliseconds (default: 5000) */
  debounceMs?: number;
}

export class RealtimeWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceMs: number;
  private lastLineRead = 0;
  private allMessages: SessionMessage[] = [];
  private filePath: string;
  private knowledgeStore: SqliteKnowledgeStore;
  private projectDir: string;
  private sessionId: string;

  constructor(
    filePath: string,
    knowledgeStore: SqliteKnowledgeStore,
    options: RealtimeWatcherOptions = {}
  ) {
    this.filePath = filePath;
    this.knowledgeStore = knowledgeStore;
    this.debounceMs = options.debounceMs ?? 5000;
    this.projectDir = basename(dirname(filePath));
    this.sessionId = basename(filePath, ".jsonl");
  }

  /**
   * Start watching the active session file.
   */
  start(): void {
    if (!existsSync(this.filePath)) return;
    if (this.watcher) return;

    this.watcher = watch(this.filePath, (_event) => {
      this.scheduleProcess();
    });
  }

  /**
   * Stop watching and clean up.
   */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Get the number of messages tracked so far.
   */
  get messageCount(): number {
    return this.allMessages.length;
  }

  /**
   * Get the line offset for the next read.
   */
  get currentOffset(): number {
    return this.lastLineRead;
  }

  /**
   * Schedule processing with debounce.
   */
  private scheduleProcess(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.processNewLines();
    }, this.debounceMs);
  }

  /**
   * Read new lines from the file and extract knowledge.
   */
  processNewLines(): void {
    if (!existsSync(this.filePath)) return;

    const { messages, totalLines } = parsePartial(this.filePath, this.lastLineRead);
    this.lastLineRead = totalLines;

    if (messages.length === 0) return;

    this.allMessages.push(...messages);

    // Build a partial session for knowledge extraction
    const partialSession: ParsedSession = {
      sessionId: this.sessionId,
      project: this.projectDir,
      cwd: "",
      gitBranch: "",
      messages: this.allMessages,
      startTime: Date.now(),
      endTime: Date.now(),
    };

    const knowledge = extractKnowledge(partialSession);
    for (const entry of knowledge) {
      this.knowledgeStore.addEntry(entry);
    }
  }
}
