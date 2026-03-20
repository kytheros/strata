/**
 * IDocumentStore interface: async-first contract for document chunk persistence.
 *
 * Extracted from SqliteDocumentStore public methods. All return types are Promise<T>
 * so that both synchronous (SQLite) and asynchronous (D1) adapters can implement them.
 */

import type { DocumentChunk, DocumentMetadata } from "../../indexing/document-store.js";

/** A single FTS search result with BM25 rank. */
export interface FtsSearchResult {
  chunk: DocumentChunk;
  rank: number;
}

export interface IDocumentStore {
  add(text: string, tokenCount: number, metadata: DocumentMetadata, tool?: string, user?: string): Promise<string>;
  get(id: string): Promise<DocumentChunk | undefined>;
  getBySession(sessionId: string): Promise<DocumentChunk[]>;
  getByProject(project: string): Promise<DocumentChunk[]>;
  remove(id: string): Promise<void>;
  removeSession(sessionId: string): Promise<void>;
  search(query: string, limit?: number, user?: string): Promise<FtsSearchResult[]>;
  getDocumentCount(): Promise<number>;
  getAverageTokenCount(): Promise<number>;
  getAllDocuments(): Promise<DocumentChunk[]>;
  getSessionIds(): Promise<Set<string>>;
  getProjects(): Promise<Set<string>>;
}
