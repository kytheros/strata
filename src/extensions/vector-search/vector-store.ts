/**
 * Vector store using SQLite for KNN search.
 *
 * Stores document embeddings alongside the existing documents table.
 * Uses brute-force cosine similarity for KNN queries.
 */

import type Database from "better-sqlite3";

export interface VectorSearchResult {
  documentId: string;
  distance: number;
}

/**
 * SQLite-backed vector store for document embeddings.
 */
export class VectorStore {
  private insertStmt: Database.Statement;
  private removeStmt: Database.Statement;
  private hasVectorStmt: Database.Statement;
  private countStmt: Database.Statement;
  private removeAllStmt: Database.Statement;

  constructor(
    private db: Database.Database,
    private dimensions: number,
    private modelName: string = "gemini-embedding-001"
  ) {
    this.initSchema();

    this.insertStmt = db.prepare(
      `INSERT OR REPLACE INTO document_vectors (document_id, vector, model, created_at)
       VALUES (?, ?, ?, ?)`
    );
    this.removeStmt = db.prepare(
      "DELETE FROM document_vectors WHERE document_id = ?"
    );
    this.hasVectorStmt = db.prepare(
      "SELECT 1 FROM document_vectors WHERE document_id = ? AND model = ?"
    );
    this.countStmt = db.prepare(
      "SELECT COUNT(*) as count FROM document_vectors WHERE model = ?"
    );
    this.removeAllStmt = db.prepare(
      "DELETE FROM document_vectors"
    );
  }

  /**
   * Initialize the document_vectors table.
   */
  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS document_vectors (
        document_id TEXT NOT NULL,
        vector BLOB NOT NULL,
        model TEXT NOT NULL DEFAULT 'gemini-embedding-001',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (document_id, model)
      );
    `);
  }

  /**
   * Add a vector for a document.
   */
  addVector(documentId: string, vector: Float32Array): void {
    if (vector.length !== this.dimensions) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.dimensions}, got ${vector.length}`
      );
    }
    const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    this.insertStmt.run(documentId, blob, this.modelName, Date.now());
  }

  /**
   * Remove a vector for a document.
   */
  removeVector(documentId: string): void {
    this.removeStmt.run(documentId);
  }

  /**
   * Check if a document already has a vector.
   */
  hasVector(documentId: string): boolean {
    return !!this.hasVectorStmt.get(documentId, this.modelName);
  }

  /**
   * Get the count of stored vectors.
   */
  getVectorCount(): number {
    const row = this.countStmt.get(this.modelName) as { count: number };
    return row.count;
  }

  /**
   * Remove all vectors (for reindexing).
   */
  removeAll(): void {
    this.removeAllStmt.run();
  }

  /**
   * KNN search using brute-force cosine similarity.
   */
  search(queryVector: Float32Array, limit: number = 20, threshold?: number): VectorSearchResult[] {
    if (queryVector.length !== this.dimensions) {
      throw new Error(
        `Query vector dimension mismatch: expected ${this.dimensions}, got ${queryVector.length}`
      );
    }

    // Brute-force cosine similarity search in JS
    const rows = this.db.prepare(
      "SELECT document_id, vector FROM document_vectors WHERE model = ?"
    ).all(this.modelName) as Array<{ document_id: string; vector: Buffer }>;

    const results: VectorSearchResult[] = [];
    for (const row of rows) {
      const storedVector = new Float32Array(
        row.vector.buffer,
        row.vector.byteOffset,
        row.vector.byteLength / 4
      );
      const similarity = cosineSimilarity(queryVector, storedVector);
      const distance = 1 - similarity;

      if (threshold !== undefined && similarity < threshold) {
        continue;
      }

      results.push({ documentId: row.document_id, distance });
    }

    results.sort((a, b) => a.distance - b.distance);
    return results.slice(0, limit);
  }
}

/**
 * Compute cosine similarity between two vectors.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}
