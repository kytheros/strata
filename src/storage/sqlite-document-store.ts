/**
 * SQLite-backed document store.
 * Replaces the in-memory Map-based DocumentStore with SQLite + FTS5.
 * Implements IDocumentStore for pluggable storage support.
 */

import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { DocumentChunk, DocumentMetadata } from "../indexing/document-store.js";
import type { IDocumentStore } from "./interfaces/index.js";

// Re-export types from interfaces for backward compatibility
export type { FtsSearchResult } from "./interfaces/document-store.js";
import type { FtsSearchResult } from "./interfaces/document-store.js";

export class SqliteDocumentStore implements IDocumentStore {
  private stmts: {
    insert: Database.Statement;
    getById: Database.Statement;
    getBySession: Database.Statement;
    getByProject: Database.Statement;
    removeById: Database.Statement;
    removeBySession: Database.Statement;
    count: Database.Statement;
    avgTokenCount: Database.Statement;
    getAll: Database.Statement;
    sessionIds: Database.Statement;
    projects: Database.Statement;
    search: Database.Statement;
    searchWithUser: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      insert: db.prepare(`
        INSERT INTO documents (id, session_id, project, tool, text, role, timestamp, tool_names, token_count, message_index, user)
        VALUES (@id, @sessionId, @project, @tool, @text, @role, @timestamp, @toolNames, @tokenCount, @messageIndex, @user)
      `),
      getById: db.prepare("SELECT * FROM documents WHERE id = ?"),
      getBySession: db.prepare("SELECT * FROM documents WHERE session_id = ? ORDER BY message_index"),
      getByProject: db.prepare("SELECT * FROM documents WHERE project = ? ORDER BY timestamp DESC"),
      removeById: db.prepare("DELETE FROM documents WHERE id = ?"),
      removeBySession: db.prepare("DELETE FROM documents WHERE session_id = ?"),
      count: db.prepare("SELECT COUNT(*) as count FROM documents"),
      avgTokenCount: db.prepare("SELECT AVG(token_count) as avg FROM documents"),
      getAll: db.prepare("SELECT * FROM documents"),
      sessionIds: db.prepare("SELECT DISTINCT session_id FROM documents"),
      projects: db.prepare("SELECT DISTINCT project FROM documents"),
      search: db.prepare(`
        SELECT d.*, bm25(documents_fts) as rank
        FROM documents_fts
        JOIN documents d ON d.rowid = documents_fts.rowid
        WHERE documents_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `),
      searchWithUser: db.prepare(`
        SELECT d.*, bm25(documents_fts) as rank
        FROM documents_fts
        JOIN documents d ON d.rowid = documents_fts.rowid
        WHERE documents_fts MATCH ?
          AND d.user = ?
        ORDER BY rank
        LIMIT ?
      `),
    };
  }

  /**
   * Add a document chunk. Returns the generated ID.
   */
  async add(
    text: string,
    tokenCount: number,
    metadata: DocumentMetadata,
    tool: string = "claude-code",
    user: string = "default"
  ): Promise<string> {
    const id = randomUUID();
    this.stmts.insert.run({
      id,
      sessionId: metadata.sessionId,
      project: metadata.project,
      tool,
      text,
      role: metadata.role,
      timestamp: metadata.timestamp,
      toolNames: JSON.stringify(metadata.toolNames),
      tokenCount,
      messageIndex: metadata.messageIndex,
      user,
    });
    return id;
  }

  /**
   * Get a document by ID.
   */
  async get(id: string): Promise<DocumentChunk | undefined> {
    const row = this.stmts.getById.get(id) as SqliteDocumentRow | undefined;
    return row ? rowToChunk(row) : undefined;
  }

  /**
   * Get all documents for a session.
   */
  async getBySession(sessionId: string): Promise<DocumentChunk[]> {
    const rows = this.stmts.getBySession.all(sessionId) as SqliteDocumentRow[];
    return rows.map(rowToChunk);
  }

  /**
   * Get all documents for a project.
   */
  async getByProject(project: string): Promise<DocumentChunk[]> {
    const rows = this.stmts.getByProject.all(project) as SqliteDocumentRow[];
    return rows.map(rowToChunk);
  }

  /**
   * Remove a document by ID.
   */
  async remove(id: string): Promise<void> {
    this.stmts.removeById.run(id);
  }

  /**
   * Remove all documents for a session.
   */
  async removeSession(sessionId: string): Promise<void> {
    this.stmts.removeBySession.run(sessionId);
  }

  /**
   * Full-text search using FTS5 with BM25 ranking.
   * Optionally filtered by user scope.
   */
  async search(query: string, limit: number = 20, user?: string): Promise<FtsSearchResult[]> {
    // Escape FTS5 special characters and build a query
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];

    const stmt = user ? this.stmts.searchWithUser : this.stmts.search;
    const args = user ? [sanitized, user, limit] : [sanitized, limit];

    try {
      const rows = stmt.all(...args) as (SqliteDocumentRow & { rank: number })[];
      const results = rows.map((row) => ({
        chunk: rowToChunk(row),
        rank: row.rank,
      }));

      // AND->OR fallback: if implicit-AND returned nothing for a multi-word
      // query, retry with OR so that entries matching any term are surfaced.
      if (results.length === 0) {
        const tokens = sanitized.split(" ").filter(Boolean);
        if (tokens.length > 1) {
          const orQuery = tokens.join(" OR ");
          const orArgs = user ? [orQuery, user, limit] : [orQuery, limit];
          const orRows = stmt.all(...orArgs) as (SqliteDocumentRow & { rank: number })[];
          return orRows.map((row) => ({
            chunk: rowToChunk(row),
            rank: row.rank,
          }));
        }
      }

      return results;
    } catch {
      // If FTS query syntax is invalid, try as a phrase
      try {
        const phraseQuery = `"${query.replace(/"/g, '""')}"`;
        const phraseArgs = user ? [phraseQuery, user, limit] : [phraseQuery, limit];
        const rows = stmt.all(...phraseArgs) as (SqliteDocumentRow & { rank: number })[];
        return rows.map((row) => ({
          chunk: rowToChunk(row),
          rank: row.rank,
        }));
      } catch {
        return [];
      }
    }
  }

  /**
   * Get total document count.
   */
  async getDocumentCount(): Promise<number> {
    const row = this.stmts.count.get() as { count: number };
    return row.count;
  }

  /**
   * Get average token count across all documents.
   */
  async getAverageTokenCount(): Promise<number> {
    const row = this.stmts.avgTokenCount.get() as { avg: number | null };
    return row.avg ?? 0;
  }

  /**
   * Get all documents.
   */
  async getAllDocuments(): Promise<DocumentChunk[]> {
    const rows = this.stmts.getAll.all() as SqliteDocumentRow[];
    return rows.map(rowToChunk);
  }

  /**
   * Get unique session IDs.
   */
  async getSessionIds(): Promise<Set<string>> {
    const rows = this.stmts.sessionIds.all() as { session_id: string }[];
    return new Set(rows.map((r) => r.session_id));
  }

  /**
   * Get unique project names.
   */
  async getProjects(): Promise<Set<string>> {
    const rows = this.stmts.projects.all() as { project: string }[];
    return new Set(rows.map((r) => r.project));
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
    let sql = `SELECT * FROM documents WHERE timestamp >= ? AND timestamp <= ?`;
    const params: unknown[] = [afterMs, beforeMs];
    if (user) {
      sql += ` AND user = ?`;
      params.push(user);
    }
    sql += ` ORDER BY timestamp DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as SqliteDocumentRow[];
    return rows.map(rowToChunk);
  }
}

// --- Internal helpers ---

interface SqliteDocumentRow {
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

function rowToChunk(row: SqliteDocumentRow): DocumentChunk {
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
 * Common English stop words that carry no semantic weight.
 * Removing these from FTS5 queries dramatically improves precision
 * of the AND→OR fallback — without removal, words like "I", "did",
 * "the" match virtually every document when used as OR terms.
 */
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "am", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "shall", "should", "may", "might", "can", "could", "must",
  "i", "me", "my", "mine", "myself", "we", "us", "our", "ours",
  "you", "your", "yours", "he", "him", "his", "she", "her", "hers",
  "it", "its", "they", "them", "their", "theirs",
  "this", "that", "these", "those",
  "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "as", "into", "through", "during", "before", "after", "above",
  "below", "between", "out", "off", "up", "down", "over", "under",
  "and", "but", "or", "nor", "not", "no", "so", "if", "then",
  "than", "too", "very", "just", "about", "also",
  "how", "what", "when", "where", "which", "who", "whom", "why",
  "all", "each", "every", "both", "few", "more", "most", "other",
  "some", "such", "any", "only", "own", "same",
  "here", "there", "again", "once", "further",
]);

/**
 * Sanitize a query string for FTS5 MATCH syntax.
 * Strips special characters, removes stop words, and joins tokens
 * with implicit AND for precise matching.
 */
function sanitizeFtsQuery(query: string): string {
  // Strip FTS5 operators and special chars, keep alphanumeric + spaces
  const cleaned = query
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "";

  // Remove stop words — critical for OR fallback precision.
  // Without this, function words like "I", "did", "the" become OR terms
  // that match virtually every document (8.7:1 distractor ratio).
  const tokens = cleaned
    .split(" ")
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t.toLowerCase()));

  // If all tokens were stop words, fall back to the original cleaned query
  // to avoid returning zero results on queries like "what is it"
  if (tokens.length === 0) {
    return cleaned.split(" ").filter(Boolean).join(" ");
  }

  return tokens.join(" ");
}
