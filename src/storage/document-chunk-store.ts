/**
 * Storage for user-uploaded documents and their embedding chunks.
 * Manages the stored_documents and document_chunks tables.
 */

import type Database from "better-sqlite3";

export interface StoredDocument {
  id: string;
  title: string;
  mimeType: string;
  project: string;
  user?: string;
  tags: string[];
  chunkCount: number;
  totalPages?: number;
  fileSize: number;
  createdAt: number;
}

export interface DocumentChunk {
  id: string;
  documentId: string;
  chunkIndex: number;
  content?: string;
  embedding: Float32Array;
  model: string;
  pageStart?: number;
  pageEnd?: number;
  tokenCount?: number;
  createdAt: number;
}

export interface ChunkEmbeddingRow {
  chunkId: string;
  documentId: string;
  project: string;
  embedding: Buffer;
}

export class DocumentChunkStore {
  private insertDoc: Database.Statement;
  private insertChunk: Database.Statement;
  private insertFts: Database.Statement;

  constructor(private db: Database.Database) {
    this.insertDoc = db.prepare(`
      INSERT INTO stored_documents (id, title, mime_type, project, user, tags, chunk_count, total_pages, file_size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.insertChunk = db.prepare(`
      INSERT INTO document_chunks (id, document_id, chunk_index, content, embedding, model, page_start, page_end, token_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.insertFts = db.prepare(`
      INSERT INTO document_chunks_fts (content, document_id, chunk_id, project)
      VALUES (?, ?, ?, ?)
    `);
  }

  /** Store a document and all its chunks in a single transaction. */
  addDocument(doc: StoredDocument, chunks: DocumentChunk[]): void {
    const txn = this.db.transaction(() => {
      this.insertDoc.run(
        doc.id,
        doc.title,
        doc.mimeType,
        doc.project,
        doc.user ?? null,
        JSON.stringify(doc.tags),
        doc.chunkCount,
        doc.totalPages ?? null,
        doc.fileSize,
        doc.createdAt
      );

      for (const chunk of chunks) {
        // Serialize Float32Array to Buffer for SQLite BLOB storage
        const embeddingBuf = Buffer.from(chunk.embedding.buffer, chunk.embedding.byteOffset, chunk.embedding.byteLength);

        this.insertChunk.run(
          chunk.id,
          chunk.documentId,
          chunk.chunkIndex,
          chunk.content ?? null,
          embeddingBuf,
          chunk.model,
          chunk.pageStart ?? null,
          chunk.pageEnd ?? null,
          chunk.tokenCount ?? null,
          chunk.createdAt
        );

        // Index text content in FTS5 for keyword search
        if (chunk.content) {
          this.insertFts.run(chunk.content, chunk.documentId, chunk.id, doc.project);
        }
      }
    });

    txn();
  }

  /** Get a document by ID. */
  getDocument(id: string): StoredDocument | undefined {
    const row = this.db.prepare("SELECT * FROM stored_documents WHERE id = ?").get(id) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      title: row.title,
      mimeType: row.mime_type,
      project: row.project,
      user: row.user ?? undefined,
      tags: row.tags ? JSON.parse(row.tags) : [],
      chunkCount: row.chunk_count,
      totalPages: row.total_pages ?? undefined,
      fileSize: row.file_size,
      createdAt: row.created_at,
    };
  }

  /** Get all chunks for a document, ordered by chunk_index. */
  getChunks(documentId: string): DocumentChunk[] {
    const rows = this.db.prepare(
      "SELECT * FROM document_chunks WHERE document_id = ? ORDER BY chunk_index"
    ).all(documentId) as any[];

    return rows.map((row) => ({
      id: row.id,
      documentId: row.document_id,
      chunkIndex: row.chunk_index,
      content: row.content ?? undefined,
      embedding: new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4),
      model: row.model,
      pageStart: row.page_start ?? undefined,
      pageEnd: row.page_end ?? undefined,
      tokenCount: row.token_count ?? undefined,
      createdAt: row.created_at,
    }));
  }

  /** Get all chunk embeddings (for brute-force vector search). */
  getAllEmbeddings(): ChunkEmbeddingRow[] {
    const rows = this.db.prepare(`
      SELECT dc.id as chunk_id, dc.document_id, sd.project, dc.embedding
      FROM document_chunks dc
      JOIN stored_documents sd ON sd.id = dc.document_id
    `).all() as any[];

    return rows.map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      project: row.project,
      embedding: row.embedding,
    }));
  }

  /** Get chunk embeddings filtered by project. */
  getEmbeddingsByProject(project: string): ChunkEmbeddingRow[] {
    const rows = this.db.prepare(`
      SELECT dc.id as chunk_id, dc.document_id, sd.project, dc.embedding
      FROM document_chunks dc
      JOIN stored_documents sd ON sd.id = dc.document_id
      WHERE LOWER(sd.project) LIKE '%' || LOWER(?) || '%'
    `).all(project) as any[];

    return rows.map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      project: row.project,
      embedding: row.embedding,
    }));
  }

  /** Delete a document and all its chunks (CASCADE). */
  deleteDocument(id: string): void {
    // Delete FTS entries first (no CASCADE on virtual tables)
    this.db.prepare(
      "DELETE FROM document_chunks_fts WHERE document_id = ?"
    ).run(id);
    // CASCADE deletes document_chunks rows
    this.db.prepare("DELETE FROM stored_documents WHERE id = ?").run(id);
  }
}
