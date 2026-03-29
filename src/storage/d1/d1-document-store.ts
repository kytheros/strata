/**
 * D1-backed document store.
 *
 * Implements IDocumentStore using Cloudflare D1 async APIs.
 * Mirrors SqliteDocumentStore method-for-method, including FTS5 BM25 search
 * with AND->OR fallback and query sanitization.
 */

import type { D1Database } from "./d1-types.js";
import type { DocumentChunk, DocumentMetadata } from "../../indexing/document-store.js";
import type { IDocumentStore, FtsSearchResult } from "../interfaces/index.js";

/** Row shape returned from D1 queries against the documents table. */
interface D1DocumentRow {
  id: string;
  session_id: string;
  project: string;
  tool: string;
  text: string;
  role: "user" | "assistant" | "mixed";
  timestamp: number;
  tool_names: string | null;
  token_count: number;
  message_index: number;
  importance: number | null;
}

function rowToChunk(row: D1DocumentRow): DocumentChunk {
  return {
    id: row.id,
    sessionId: row.session_id,
    project: row.project,
    text: row.text,
    role: row.role,
    timestamp: row.timestamp,
    toolNames: row.tool_names ? JSON.parse(row.tool_names) : [],
    tokenCount: row.token_count,
    messageIndex: row.message_index,
    importance: row.importance ?? undefined,
  };
}

/**
 * Sanitize a query string for FTS5 MATCH syntax.
 * Converts user input into safe FTS5 query tokens.
 * Duplicated from SqliteDocumentStore to avoid cross-adapter imports.
 */
function sanitizeFtsQuery(query: string): string {
  // Strip FTS5 operators and special chars, keep alphanumeric + spaces
  const cleaned = query
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "";

  // Join tokens with implicit AND
  const tokens = cleaned.split(" ").filter(Boolean);
  return tokens.join(" ");
}

/**
 * Generate a UUID v4. Uses crypto.randomUUID() when available (Workers runtime),
 * otherwise falls back to a manual implementation.
 */
function generateUUID(): string {
  if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class D1DocumentStore implements IDocumentStore {
  constructor(
    private db: D1Database,
    private userId: string,
  ) {}

  async add(
    text: string,
    tokenCount: number,
    metadata: DocumentMetadata,
    tool: string = "claude-code",
    user: string = "default"
  ): Promise<string> {
    const id = generateUUID();
    const effectiveUser = user || this.userId;
    await this.db
      .prepare(`
        INSERT INTO documents (id, session_id, project, tool, text, role, timestamp, tool_names, token_count, message_index, user)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
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
        effectiveUser
      )
      .run();
    return id;
  }

  async get(id: string): Promise<DocumentChunk | undefined> {
    const row = await this.db
      .prepare("SELECT * FROM documents WHERE id = ? AND user = ?")
      .bind(id, this.userId)
      .first<D1DocumentRow>();
    return row ? rowToChunk(row) : undefined;
  }

  async getBySession(sessionId: string): Promise<DocumentChunk[]> {
    const result = await this.db
      .prepare("SELECT * FROM documents WHERE session_id = ? AND user = ? ORDER BY message_index")
      .bind(sessionId, this.userId)
      .all<D1DocumentRow>();
    return result.results.map(rowToChunk);
  }

  async getByProject(project: string): Promise<DocumentChunk[]> {
    const result = await this.db
      .prepare("SELECT * FROM documents WHERE project = ? AND user = ? ORDER BY timestamp DESC")
      .bind(project, this.userId)
      .all<D1DocumentRow>();
    return result.results.map(rowToChunk);
  }

  async remove(id: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM documents WHERE id = ? AND user = ?")
      .bind(id, this.userId)
      .run();
  }

  async removeSession(sessionId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM documents WHERE session_id = ? AND user = ?")
      .bind(sessionId, this.userId)
      .run();
  }

  /**
   * Full-text search using FTS5 with BM25 ranking.
   * Includes AND->OR fallback and phrase query fallback, matching SQLite behavior.
   */
  async search(query: string, limit: number = 20, user?: string): Promise<FtsSearchResult[]> {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];

    const effectiveUser = user ?? this.userId;

    const baseSql = `
      SELECT d.*, bm25(documents_fts) as rank
      FROM documents_fts
      JOIN documents d ON d.rowid = documents_fts.rowid
      WHERE documents_fts MATCH ?
        AND d.user = ?
      ORDER BY rank
      LIMIT ?
    `;

    try {
      const result = await this.db
        .prepare(baseSql)
        .bind(sanitized, effectiveUser, limit)
        .all<D1DocumentRow & { rank: number }>();

      const results = result.results.map((row) => ({
        chunk: rowToChunk(row),
        rank: row.rank,
      }));

      // AND->OR fallback: if implicit-AND returned nothing for a multi-word
      // query, retry with OR so that entries matching any term are surfaced.
      if (results.length === 0) {
        const tokens = sanitized.split(" ").filter(Boolean);
        if (tokens.length > 1) {
          const orQuery = tokens.join(" OR ");
          const orResult = await this.db
            .prepare(baseSql)
            .bind(orQuery, effectiveUser, limit)
            .all<D1DocumentRow & { rank: number }>();
          return orResult.results.map((row) => ({
            chunk: rowToChunk(row),
            rank: row.rank,
          }));
        }
      }

      return results;
    } catch {
      // If FTS query syntax is invalid, sanitize and try as a phrase
      try {
        const sanitizedPhrase = sanitizeFtsQuery(query);
        if (!sanitizedPhrase) return [];
        const phraseQuery = `"${sanitizedPhrase}"`;
        const result = await this.db
          .prepare(baseSql)
          .bind(phraseQuery, effectiveUser, limit)
          .all<D1DocumentRow & { rank: number }>();
        return result.results.map((row) => ({
          chunk: rowToChunk(row),
          rank: row.rank,
        }));
      } catch {
        return [];
      }
    }
  }

  async getDocumentCount(): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) as count FROM documents WHERE user = ?")
      .bind(this.userId)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  async getAverageTokenCount(): Promise<number> {
    const row = await this.db
      .prepare("SELECT AVG(token_count) as avg FROM documents WHERE user = ?")
      .bind(this.userId)
      .first<{ avg: number | null }>();
    return row?.avg ?? 0;
  }

  async getAllDocuments(): Promise<DocumentChunk[]> {
    const result = await this.db
      .prepare("SELECT * FROM documents WHERE user = ?")
      .bind(this.userId)
      .all<D1DocumentRow>();
    return result.results.map(rowToChunk);
  }

  async getSessionIds(): Promise<Set<string>> {
    const result = await this.db
      .prepare("SELECT DISTINCT session_id FROM documents WHERE user = ?")
      .bind(this.userId)
      .all<{ session_id: string }>();
    return new Set(result.results.map((r) => r.session_id));
  }

  async getProjects(): Promise<Set<string>> {
    const result = await this.db
      .prepare("SELECT DISTINCT project FROM documents WHERE user = ?")
      .bind(this.userId)
      .all<{ project: string }>();
    return new Set(result.results.map((r) => r.project));
  }

  /**
   * Browse documents within a date range (no text query required).
   * Returns chunks ordered by timestamp descending.
   */
  async searchByDateRange(
    afterMs: number,
    beforeMs: number,
    limit: number = 30,
    user?: string
  ): Promise<DocumentChunk[]> {
    const effectiveUser = user ?? this.userId;
    const result = await this.db
      .prepare(
        `SELECT * FROM documents WHERE timestamp >= ? AND timestamp <= ? AND user = ? ORDER BY timestamp DESC LIMIT ?`
      )
      .bind(afterMs, beforeMs, effectiveUser, limit)
      .all<D1DocumentRow>();
    return result.results.map(rowToChunk);
  }
}
