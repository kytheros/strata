/**
 * SQLite-backed document store.
 * Replaces the in-memory Map-based DocumentStore with SQLite + FTS5.
 */

import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { DocumentChunk, DocumentMetadata } from "../indexing/document-store.js";

export interface FtsSearchResult {
  chunk: DocumentChunk;
  rank: number;
}

export class SqliteDocumentStore {
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
  add(
    text: string,
    tokenCount: number,
    metadata: DocumentMetadata,
    tool: string = "claude-code",
    user: string = "default"
  ): string {
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
  get(id: string): DocumentChunk | undefined {
    const row = this.stmts.getById.get(id) as SqliteDocumentRow | undefined;
    return row ? rowToChunk(row) : undefined;
  }

  /**
   * Get all documents for a session.
   */
  getBySession(sessionId: string): DocumentChunk[] {
    const rows = this.stmts.getBySession.all(sessionId) as SqliteDocumentRow[];
    return rows.map(rowToChunk);
  }

  /**
   * Get all documents for a project.
   */
  getByProject(project: string): DocumentChunk[] {
    const rows = this.stmts.getByProject.all(project) as SqliteDocumentRow[];
    return rows.map(rowToChunk);
  }

  /**
   * Remove a document by ID.
   */
  remove(id: string): void {
    this.stmts.removeById.run(id);
  }

  /**
   * Remove all documents for a session.
   */
  removeSession(sessionId: string): void {
    this.stmts.removeBySession.run(sessionId);
  }

  /**
   * Full-text search using FTS5 with BM25 ranking.
   * Optionally filtered by user scope.
   */
  search(query: string, limit: number = 20, user?: string): FtsSearchResult[] {
    // Escape FTS5 special characters and build a query
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];

    const stmt = user ? this.stmts.searchWithUser : this.stmts.search;
    const args = user ? [sanitized, user, limit] : [sanitized, limit];

    try {
      const rows = stmt.all(...args) as (SqliteDocumentRow & { rank: number })[];
      return rows.map((row) => ({
        chunk: rowToChunk(row),
        rank: row.rank,
      }));
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
  getDocumentCount(): number {
    const row = this.stmts.count.get() as { count: number };
    return row.count;
  }

  /**
   * Get average token count across all documents.
   */
  getAverageTokenCount(): number {
    const row = this.stmts.avgTokenCount.get() as { avg: number | null };
    return row.avg ?? 0;
  }

  /**
   * Get all documents.
   */
  getAllDocuments(): DocumentChunk[] {
    const rows = this.stmts.getAll.all() as SqliteDocumentRow[];
    return rows.map(rowToChunk);
  }

  /**
   * Get unique session IDs.
   */
  getSessionIds(): Set<string> {
    const rows = this.stmts.sessionIds.all() as { session_id: string }[];
    return new Set(rows.map((r) => r.session_id));
  }

  /**
   * Get unique project names.
   */
  getProjects(): Set<string> {
    const rows = this.stmts.projects.all() as { project: string }[];
    return new Set(rows.map((r) => r.project));
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
 * Sanitize a query string for FTS5 MATCH syntax.
 * Converts user input into safe FTS5 query tokens.
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
