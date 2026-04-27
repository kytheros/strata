/**
 * Postgres-backed document chunk store.
 *
 * Port of SqliteDocumentChunkStore with Postgres-specific SQL.
 * Uses tsvector GENERATED column + GIN index for FTS on document_chunks.
 * Embeddings are stored as bytea (same binary format as SQLite BLOBs).
 */

import type { PgPool } from "./pg-types.js";
import type {
  StoredDocument,
  DocumentChunk,
  ChunkEmbeddingRow,
  DocChunkFtsResult,
} from "../document-chunk-store.js";

export class PgDocumentChunkStore {
  constructor(private pool: PgPool) {}

  /** Store a document and all its chunks in a single transaction. */
  async addDocument(doc: StoredDocument, chunks: DocumentChunk[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO stored_documents (id, title, mime_type, project, user_scope, tags, chunk_count, total_pages, file_size, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          doc.id,
          doc.title,
          doc.mimeType,
          doc.project,
          doc.user ?? null,
          JSON.stringify(doc.tags),
          doc.chunkCount,
          doc.totalPages ?? null,
          doc.fileSize,
          doc.createdAt,
        ]
      );

      for (const chunk of chunks) {
        // Serialize Float32Array to Buffer for Postgres bytea storage
        const embeddingBuf = Buffer.from(
          chunk.embedding.buffer,
          chunk.embedding.byteOffset,
          chunk.embedding.byteLength
        );

        await client.query(
          `INSERT INTO document_chunks (id, document_id, chunk_index, content, embedding, model, page_start, page_end, token_count, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            chunk.id,
            chunk.documentId,
            chunk.chunkIndex,
            chunk.content ?? null,
            embeddingBuf,
            chunk.model,
            chunk.pageStart ?? null,
            chunk.pageEnd ?? null,
            chunk.tokenCount ?? null,
            chunk.createdAt,
          ]
        );
      }

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  /** Get a document by ID. */
  async getDocument(id: string): Promise<StoredDocument | undefined> {
    const { rows } = await this.pool.query<{
      id: string; title: string; mime_type: string; project: string;
      user_scope: string | null; tags: string | null; chunk_count: number;
      total_pages: number | null; file_size: number; created_at: string;
    }>(
      "SELECT * FROM stored_documents WHERE id = $1",
      [id]
    );

    if (rows.length === 0) return undefined;
    const row = rows[0];
    return {
      id: row.id,
      title: row.title,
      mimeType: row.mime_type,
      project: row.project,
      user: row.user_scope ?? undefined,
      tags: row.tags ? JSON.parse(row.tags) : [],
      chunkCount: row.chunk_count,
      totalPages: row.total_pages ?? undefined,
      fileSize: row.file_size,
      createdAt: Number(row.created_at),
    };
  }

  /** Get all chunks for a document, ordered by chunk_index. */
  async getChunks(documentId: string): Promise<DocumentChunk[]> {
    const { rows } = await this.pool.query<{
      id: string; document_id: string; chunk_index: number;
      content: string | null; embedding: Buffer;
      model: string; page_start: number | null; page_end: number | null;
      token_count: number | null; created_at: string;
    }>(
      "SELECT * FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index",
      [documentId]
    );

    return rows.map((row) => {
      const buf = Buffer.isBuffer(row.embedding) ? row.embedding : Buffer.from(row.embedding as unknown as ArrayBuffer);
      return {
        id: row.id,
        documentId: row.document_id,
        chunkIndex: row.chunk_index,
        content: row.content ?? undefined,
        embedding: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4),
        model: row.model,
        pageStart: row.page_start ?? undefined,
        pageEnd: row.page_end ?? undefined,
        tokenCount: row.token_count ?? undefined,
        createdAt: Number(row.created_at),
      };
    });
  }

  /** Get all chunk embeddings (for brute-force vector search). */
  async getAllEmbeddings(): Promise<ChunkEmbeddingRow[]> {
    const { rows } = await this.pool.query<{
      chunk_id: string; document_id: string; project: string; embedding: Buffer;
    }>(
      `SELECT dc.id as chunk_id, dc.document_id, sd.project, dc.embedding
       FROM document_chunks dc
       JOIN stored_documents sd ON sd.id = dc.document_id`
    );

    return rows.map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      project: row.project,
      embedding: Buffer.isBuffer(row.embedding) ? row.embedding : Buffer.from(row.embedding as unknown as ArrayBuffer),
    }));
  }

  /** Get chunk embeddings filtered by project. */
  async getEmbeddingsByProject(project: string): Promise<ChunkEmbeddingRow[]> {
    const { rows } = await this.pool.query<{
      chunk_id: string; document_id: string; project: string; embedding: Buffer;
    }>(
      `SELECT dc.id as chunk_id, dc.document_id, sd.project, dc.embedding
       FROM document_chunks dc
       JOIN stored_documents sd ON sd.id = dc.document_id
       WHERE LOWER(sd.project) LIKE '%' || LOWER($1) || '%'`,
      [project]
    );

    return rows.map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      project: row.project,
      embedding: Buffer.isBuffer(row.embedding) ? row.embedding : Buffer.from(row.embedding as unknown as ArrayBuffer),
    }));
  }

  /**
   * Full-text search over stored document chunks using tsvector.
   * Returns results ranked by ts_rank (positive, higher = better).
   */
  async searchFts(query: string, limit: number): Promise<DocChunkFtsResult[]> {
    if (!query.trim()) return [];

    const { rows } = await this.pool.query<{
      chunk_id: string; document_id: string; project: string;
      content: string; title: string; created_at: string; rank: number;
    }>(
      `SELECT
         dc.id as chunk_id,
         dc.document_id,
         sd.project,
         dc.content,
         sd.title,
         dc.created_at,
         ts_rank(dc.tsv, plainto_tsquery('english', $1)) as rank
       FROM document_chunks dc
       JOIN stored_documents sd ON sd.id = dc.document_id
       WHERE dc.tsv @@ plainto_tsquery('english', $1)
       ORDER BY rank DESC
       LIMIT $2`,
      [query, limit]
    );

    return rows.map((r) => ({
      chunkId: r.chunk_id,
      documentId: r.document_id,
      project: r.project,
      title: r.title,
      content: r.content,
      rank: r.rank,
      createdAt: Number(r.created_at),
    }));
  }

  /** Get a single chunk with its parent document metadata. */
  async getChunkWithMeta(chunkId: string): Promise<DocChunkFtsResult | undefined> {
    const { rows } = await this.pool.query<{
      chunk_id: string; document_id: string; project: string;
      title: string; content: string | null; created_at: string;
    }>(
      `SELECT dc.id as chunk_id, dc.document_id, sd.project, sd.title,
              dc.content, dc.created_at
       FROM document_chunks dc
       JOIN stored_documents sd ON sd.id = dc.document_id
       WHERE dc.id = $1`,
      [chunkId]
    );

    if (rows.length === 0) return undefined;
    const row = rows[0];
    return {
      chunkId: row.chunk_id,
      documentId: row.document_id,
      project: row.project,
      title: row.title,
      content: row.content ?? "",
      rank: 0,
      createdAt: Number(row.created_at),
    };
  }

  /** Delete a document and all its chunks (CASCADE handles chunk deletion). */
  async deleteDocument(id: string): Promise<void> {
    await this.pool.query("DELETE FROM stored_documents WHERE id = $1", [id]);
  }
}
