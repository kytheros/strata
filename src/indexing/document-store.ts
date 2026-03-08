/**
 * Document store: holds indexed document chunks with metadata.
 * Each "document" is a chunk of a conversation session.
 *
 * Uses Map<string, DocumentChunk> for O(1) lookups and stable IDs
 * after removal operations.
 */

import { randomUUID } from "crypto";

export interface DocumentChunk {
  id: string;
  sessionId: string;
  project: string;
  text: string;
  role: "user" | "assistant" | "mixed";
  timestamp: number;
  toolNames: string[];
  tokenCount: number;
  messageIndex: number; // Position within session
}

export interface DocumentMetadata {
  sessionId: string;
  project: string;
  role: "user" | "assistant" | "mixed";
  timestamp: number;
  toolNames: string[];
  messageIndex: number;
}

export class DocumentStore {
  private documents = new Map<string, DocumentChunk>();

  addDocument(
    text: string,
    tokenCount: number,
    metadata: DocumentMetadata
  ): string {
    const id = randomUUID();
    this.documents.set(id, {
      id,
      text,
      tokenCount,
      ...metadata,
    });
    return id;
  }

  getDocument(id: string): DocumentChunk | undefined {
    return this.documents.get(id);
  }

  getDocumentCount(): number {
    return this.documents.size;
  }

  getAverageTokenCount(): number {
    if (this.documents.size === 0) return 0;
    let total = 0;
    for (const d of this.documents.values()) {
      total += d.tokenCount;
    }
    return total / this.documents.size;
  }

  getAllDocuments(): DocumentChunk[] {
    return [...this.documents.values()];
  }

  /**
   * Get documents for a specific session.
   */
  getSessionDocuments(sessionId: string): DocumentChunk[] {
    const results: DocumentChunk[] = [];
    for (const d of this.documents.values()) {
      if (d.sessionId === sessionId) results.push(d);
    }
    return results;
  }

  /**
   * Get documents for a specific project.
   */
  getProjectDocuments(project: string): DocumentChunk[] {
    const results: DocumentChunk[] = [];
    for (const d of this.documents.values()) {
      if (d.project === project) results.push(d);
    }
    return results;
  }

  /**
   * Remove all documents for a session (for re-indexing).
   * O(n) scan but does not break ID-based lookups.
   */
  removeSession(sessionId: string): void {
    for (const [id, doc] of this.documents) {
      if (doc.sessionId === sessionId) {
        this.documents.delete(id);
      }
    }
  }

  /**
   * Get unique session IDs.
   */
  getSessionIds(): Set<string> {
    const ids = new Set<string>();
    for (const d of this.documents.values()) {
      ids.add(d.sessionId);
    }
    return ids;
  }

  /**
   * Get unique project names.
   */
  getProjects(): Set<string> {
    const projects = new Set<string>();
    for (const d of this.documents.values()) {
      projects.add(d.project);
    }
    return projects;
  }

  /**
   * Serialize for persistence.
   */
  serialize(): SerializedDocumentStore {
    return {
      documents: [...this.documents.values()],
    };
  }

  /**
   * Restore from serialized data.
   */
  static deserialize(data: SerializedDocumentStore): DocumentStore {
    const store = new DocumentStore();
    for (const doc of data.documents) {
      store.documents.set(doc.id, doc);
    }
    return store;
  }
}

export interface SerializedDocumentStore {
  documents: DocumentChunk[];
}
