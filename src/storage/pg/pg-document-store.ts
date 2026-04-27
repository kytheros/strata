/**
 * Postgres-backed document store.
 *
 * Implements IDocumentStore using pg Pool async APIs.
 * Mirrors D1DocumentStore method-for-method, with Postgres-specific SQL:
 * - ts_rank(tsv, plainto_tsquery(...)) for FTS (positive scores, higher=better)
 * - $1/$2/... parameterized queries instead of ?
 * - ON CONFLICT DO UPDATE instead of INSERT OR REPLACE
 */

import type { PgPool } from "./pg-types.js";
import type { DocumentChunk, DocumentMetadata } from "../../indexing/document-store.js";
import type { IDocumentStore, FtsSearchResult } from "../interfaces/index.js";
import { randomUUID } from "crypto";

/** Row shape returned from Postgres queries against the documents table. */
interface PgDocumentRow {
  id: string;
  session_id: string;
  project: string;
  tool: string;
  text: string;
  role: "user" | "assistant" | "mixed";
  timestamp: string; // bigint comes as string from pg
  tool_names: string | null;
  token_count: number;
  message_index: number;
  importance: number | null;
}

function rowToChunk(row: PgDocumentRow): DocumentChunk {
  return {
    id: row.id,
    sessionId: row.session_id,
    project: row.project,
    text: row.text,
    role: row.role,
    timestamp: Number(row.timestamp),
    toolNames: row.tool_names ? JSON.parse(row.tool_names) : [],
    tokenCount: row.token_count,
    messageIndex: row.message_index,
    importance: row.importance ?? undefined,
  };
}

export class PgDocumentStore implements IDocumentStore {
  constructor(
    private pool: PgPool,
    private userId: string,
  ) {}

  async add(
    text: string,
    tokenCount: number,
    metadata: DocumentMetadata,
    tool: string = "claude-code",
    user?: string
  ): Promise<string> {
    const id = randomUUID();
    const effectiveUser = user || this.userId;
    await this.pool.query(
      `INSERT INTO documents (id, session_id, project, tool, text, role, timestamp, tool_names, token_count, message_index, user_scope)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        metadata.sessionId,
        metadata.project,
        tool,
        text,
        metadata.role,
        metadata.timestamp,
        JSON.stringify(metadata.toolNames),
        tokenCount,
        metadata.messageIndex,
        effectiveUser,
      ]
    );
    return id;
  }

  async get(id: string): Promise<DocumentChunk | undefined> {
    const { rows } = await this.pool.query<PgDocumentRow>(
      "SELECT * FROM documents WHERE id = $1 AND user_scope = $2",
      [id, this.userId]
    );
    return rows.length > 0 ? rowToChunk(rows[0]) : undefined;
  }

  async getBySession(sessionId: string): Promise<DocumentChunk[]> {
    const { rows } = await this.pool.query<PgDocumentRow>(
      "SELECT * FROM documents WHERE session_id = $1 AND user_scope = $2 ORDER BY message_index",
      [sessionId, this.userId]
    );
    return rows.map(rowToChunk);
  }

  async getByProject(project: string): Promise<DocumentChunk[]> {
    const { rows } = await this.pool.query<PgDocumentRow>(
      "SELECT * FROM documents WHERE project = $1 AND user_scope = $2 ORDER BY timestamp DESC",
      [project, this.userId]
    );
    return rows.map(rowToChunk);
  }

  async remove(id: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM documents WHERE id = $1 AND user_scope = $2",
      [id, this.userId]
    );
  }

  async removeSession(sessionId: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM documents WHERE session_id = $1 AND user_scope = $2",
      [sessionId, this.userId]
    );
  }

  /**
   * Full-text search using Postgres tsvector with ts_rank ranking.
   * Returns positive scores (higher = better match).
   * No sign flip needed -- unlike FTS5 bm25() which returns negative scores.
   */
  async search(query: string, limit: number = 20, user?: string): Promise<FtsSearchResult[]> {
    if (!query.trim()) return [];

    const effectiveUser = user ?? this.userId;

    // Primary search with plainto_tsquery (safe: no syntax errors from special chars)
    const { rows } = await this.pool.query<PgDocumentRow & { rank: number }>(
      `SELECT d.*, ts_rank(d.tsv, plainto_tsquery('english', $1)) AS rank
       FROM documents d
       WHERE d.tsv @@ plainto_tsquery('english', $1)
         AND d.user_scope = $2
       ORDER BY rank DESC
       LIMIT $3`,
      [query, effectiveUser, limit]
    );

    if (rows.length > 0) {
      return rows.map((row) => ({
        chunk: rowToChunk(row),
        rank: row.rank,
      }));
    }

    // Fallback: try websearch_to_tsquery which handles OR/AND operators
    try {
      const { rows: wsRows } = await this.pool.query<PgDocumentRow & { rank: number }>(
        `SELECT d.*, ts_rank(d.tsv, websearch_to_tsquery('english', $1)) AS rank
         FROM documents d
         WHERE d.tsv @@ websearch_to_tsquery('english', $1)
           AND d.user_scope = $2
         ORDER BY rank DESC
         LIMIT $3`,
        [query, effectiveUser, limit]
      );
      return wsRows.map((row) => ({
        chunk: rowToChunk(row),
        rank: row.rank,
      }));
    } catch {
      return [];
    }
  }

  async searchByDateRange(
    afterMs: number,
    beforeMs: number,
    limit: number = 30,
    user?: string
  ): Promise<DocumentChunk[]> {
    const effectiveUser = user ?? this.userId;
    const { rows } = await this.pool.query<PgDocumentRow>(
      `SELECT * FROM documents
       WHERE timestamp >= $1 AND timestamp <= $2 AND user_scope = $3
       ORDER BY timestamp DESC LIMIT $4`,
      [afterMs, beforeMs, effectiveUser, limit]
    );
    return rows.map(rowToChunk);
  }

  async getDocumentCount(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      "SELECT COUNT(*) as count FROM documents WHERE user_scope = $1",
      [this.userId]
    );
    return Number(rows[0].count);
  }

  async getAverageTokenCount(): Promise<number> {
    const { rows } = await this.pool.query<{ avg: string | null }>(
      "SELECT AVG(token_count) as avg FROM documents WHERE user_scope = $1",
      [this.userId]
    );
    return rows[0].avg ? Number(rows[0].avg) : 0;
  }

  async getAllDocuments(): Promise<DocumentChunk[]> {
    const { rows } = await this.pool.query<PgDocumentRow>(
      "SELECT * FROM documents WHERE user_scope = $1",
      [this.userId]
    );
    return rows.map(rowToChunk);
  }

  async getSessionIds(): Promise<Set<string>> {
    const { rows } = await this.pool.query<{ session_id: string }>(
      "SELECT DISTINCT session_id FROM documents WHERE user_scope = $1",
      [this.userId]
    );
    return new Set(rows.map((r) => r.session_id));
  }

  async getProjects(): Promise<Set<string>> {
    const { rows } = await this.pool.query<{ project: string }>(
      "SELECT DISTINCT project FROM documents WHERE user_scope = $1",
      [this.userId]
    );
    return new Set(rows.map((r) => r.project));
  }
}
