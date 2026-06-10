/**
 * Orchestrate indexing: parse sessions, chunk text, build BM25 + TF-IDF indexes.
 * Handles persistence via msgpack and incremental updates.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { CONFIG } from "../config.js";
import {
  enumerateSessionFiles,
  parseSessionFile,
  type ParsedSession,
  type SessionFileInfo,
} from "../parsers/session-parser.js";
import { chunkSession as sharedChunkSession } from "./chunk-session.js";
import { tokenize } from "./tokenizer.js";
import { BM25Index, type SerializedBM25 } from "./bm25.js";
import { TFIDFIndex, type SerializedTFIDF } from "./tfidf.js";
import {
  DocumentStore,
  type SerializedDocumentStore,
} from "./document-store.js";

export interface IndexMeta {
  lastIndexed: Record<string, number>; // filePath -> mtime
  buildTime: number;
  version: number;
}

interface SerializedIndex {
  bm25: SerializedBM25;
  tfidf: SerializedTFIDF;
  documents: SerializedDocumentStore;
  meta: IndexMeta;
}

export class IndexManager {
  bm25: BM25Index;
  tfidf: TFIDFIndex;
  documents: DocumentStore;
  private meta: IndexMeta;
  /** Optional override for the projects directory (used in tests). */
  private projectsDir?: string;

  constructor(projectsDir?: string) {
    this.projectsDir = projectsDir;
    this.bm25 = new BM25Index();
    this.tfidf = new TFIDFIndex();
    this.documents = new DocumentStore();
    this.meta = {
      lastIndexed: {},
      buildTime: 0,
      version: 1,
    };
  }

  /**
   * Build or rebuild the full index from scratch.
   */
  async buildFullIndex(): Promise<{ sessions: number; chunks: number }> {
    const startTime = Date.now();
    const files = enumerateSessionFiles(this.projectsDir);

    // Reset everything
    this.bm25 = new BM25Index();
    this.tfidf = new TFIDFIndex();
    this.documents = new DocumentStore();
    this.meta = {
      lastIndexed: {},
      buildTime: 0,
      version: 1,
    };

    let sessionCount = 0;

    for (const file of files) {
      this.indexFile(file);
      sessionCount++;
    }

    this.meta.buildTime = Date.now() - startTime;
    return {
      sessions: sessionCount,
      chunks: this.documents.getDocumentCount(),
    };
  }

  /**
   * Incrementally update: only re-index files that changed since last index.
   */
  async incrementalUpdate(): Promise<{
    added: number;
    updated: number;
    unchanged: number;
  }> {
    const files = enumerateSessionFiles(this.projectsDir);
    let added = 0;
    let updated = 0;
    let unchanged = 0;

    for (const file of files) {
      const lastMtime = this.meta.lastIndexed[file.filePath];

      if (lastMtime === undefined) {
        // New file
        this.indexFile(file);
        added++;
      } else if (file.mtime > lastMtime) {
        // Updated file — remove old docs and re-index
        this.removeSession(file.sessionId);
        this.indexFile(file);
        updated++;
      } else {
        unchanged++;
      }
    }

    return { added, updated, unchanged };
  }

  /**
   * Index a single session file.
   */
  private indexFile(file: SessionFileInfo): void {
    const session = parseSessionFile(file.filePath, file.projectDir);
    if (!session) return;

    const chunks = this.chunkSession(session);
    for (const chunk of chunks) {
      const tokens = tokenize(chunk.text, { includeBigrams: true });
      const docId = this.documents.addDocument(chunk.text, tokens.length, {
        sessionId: session.sessionId,
        project: session.project,
        role: chunk.role,
        timestamp: chunk.timestamp,
        toolNames: chunk.toolNames,
        messageIndex: chunk.messageIndex,
      });
      this.bm25.addDocument(docId, tokens);
      this.tfidf.addDocument(docId, tokens);
    }

    this.meta.lastIndexed[file.filePath] = file.mtime;
  }

  /**
   * Remove a session from all indexes.
   */
  private removeSession(sessionId: string): void {
    const docs = this.documents.getSessionDocuments(sessionId);
    for (const doc of docs) {
      this.bm25.removeDocument(doc.id);
      this.tfidf.removeDocument(doc.id);
    }
    this.documents.removeSession(sessionId);
  }

  /**
   * Chunk a session into indexable pieces.
   * Delegates to the shared chunkSession export (src/indexing/chunk-session.ts)
   * so the conversation-ingest write-path (#30) can reuse the same AutoResearch-tuned
   * chunker without duplicating logic.
   */
  private chunkSession(session: ParsedSession) {
    return sharedChunkSession(session);
  }

  /**
   * Save index to disk using msgpack.
   */
  async save(): Promise<void> {
    const dir = dirname(CONFIG.indexFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const data: SerializedIndex = {
      bm25: this.bm25.serialize(),
      tfidf: this.tfidf.serialize(),
      documents: this.documents.serialize(),
      meta: this.meta,
    };

    try {
      const { pack } = await import("msgpackr" as string);
      const packed = pack(data);
      writeFileSync(CONFIG.indexFile, packed);
    } catch {
      // Fallback to JSON if msgpack fails
      writeFileSync(
        CONFIG.indexFile.replace(".msgpack", ".json"),
        JSON.stringify(data)
      );
    }
  }

  /**
   * Load index from disk.
   */
  async load(): Promise<boolean> {
    // Try msgpack first
    if (existsSync(CONFIG.indexFile)) {
      try {
        const { unpack } = await import("msgpackr" as string);
        const raw = readFileSync(CONFIG.indexFile);
        const data = unpack(raw) as SerializedIndex;
        this.restoreFromSerialized(data);
        return true;
      } catch {
        // Fall through to JSON
      }
    }

    // Try JSON fallback
    const jsonFile = CONFIG.indexFile.replace(".msgpack", ".json");
    if (existsSync(jsonFile)) {
      try {
        const raw = readFileSync(jsonFile, "utf-8");
        const data = JSON.parse(raw) as SerializedIndex;
        this.restoreFromSerialized(data);
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }

  private restoreFromSerialized(data: SerializedIndex): void {
    this.bm25 = BM25Index.deserialize(data.bm25);
    this.tfidf = TFIDFIndex.deserialize(data.tfidf);
    this.documents = DocumentStore.deserialize(data.documents);
    this.meta = data.meta;
  }

  /**
   * Get index statistics.
   */
  getStats(): {
    documents: number;
    sessions: number;
    projects: number;
    vocabulary: number;
    buildTimeMs: number;
  } {
    return {
      documents: this.documents.getDocumentCount(),
      sessions: this.documents.getSessionIds().size,
      projects: this.documents.getProjects().size,
      vocabulary: this.bm25.getVocabularySize(),
      buildTimeMs: this.meta.buildTime,
    };
  }
}
