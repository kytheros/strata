/**
 * SQLite-backed knowledge store.
 * Replaces the JSON file-based KnowledgeStore with SQLite persistence.
 * Implements IKnowledgeStore for pluggable storage support.
 */

import type Database from "better-sqlite3";
import type { KnowledgeEntry } from "../knowledge/knowledge-store.js";
import { parseProcedureDetails } from "../knowledge/procedure-extractor.js";
import type { ProcedureDetails } from "../knowledge/procedure-extractor.js";
import type { GeminiEmbedder } from "../extensions/embeddings/gemini-embedder.js";
import type { IKnowledgeStore, KnowledgeListOptions } from "./interfaces/index.js";
import { quantize } from "../extensions/quantization/turbo-quant.js";
import { CONFIG } from "../config.js";

// Re-export types from interfaces for backward compatibility
export type { KnowledgeUpdatePatch, KnowledgeHistoryRow } from "./interfaces/knowledge-store.js";
import type { KnowledgeUpdatePatch, KnowledgeHistoryRow } from "./interfaces/knowledge-store.js";

/** Default user value resolved from env. */
const DEFAULT_USER = process.env.STRATA_DEFAULT_USER || "default";

/** Escape SQL LIKE wildcards (% and _) in user input to prevent pattern injection. */
function escapeLike(input: string): string {
  return input.replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Common English stop words that carry no semantic weight.
 * Removing these from FTS5 queries improves precision —
 * without removal, function words match virtually every row in OR mode.
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
 * with implicit AND for precise matching (OR fallback handled by caller).
 */
function sanitizeFtsQuery(query: string): string {
  // Strip FTS5 operators and special chars, keep alphanumeric + spaces
  const cleaned = query
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "";

  const tokens = cleaned
    .split(" ")
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t.toLowerCase()));

  // If all tokens were stop words, fall back to the original cleaned query
  if (tokens.length === 0) {
    return cleaned.split(" ").filter(Boolean).join(" ");
  }

  return tokens.join(" ");
}

export class SqliteKnowledgeStore implements IKnowledgeStore {
  private defaultUser: string;

  /** Whether the knowledge_fts virtual table exists (for FTS5 search). */
  private hasFts: boolean;

  private stmts: {
    insert: Database.Statement;
    upsert: Database.Statement;
    getById: Database.Statement;
    getByProject: Database.Statement;
    getByProjectAndUser: Database.Statement;
    getByType: Database.Statement;
    getByTypeAndProject: Database.Statement;
    getByTypeAndUser: Database.Statement;
    getByTypeAndProjectAndUser: Database.Statement;
    // LIKE-based fallback search (used when knowledge_fts is unavailable)
    searchLike: Database.Statement;
    searchLikeWithProject: Database.Statement;
    searchLikeWithUser: Database.Statement;
    searchLikeWithProjectAndUser: Database.Statement;
    // FTS5-based search (used when knowledge_fts exists)
    searchFts: Database.Statement | null;
    searchFtsWithProject: Database.Statement | null;
    searchFtsWithUser: Database.Statement | null;
    searchFtsWithProjectAndUser: Database.Statement | null;
    getAll: Database.Statement;
    getAllWithUser: Database.Statement;
    count: Database.Statement;
    remove: Database.Statement;
    getLearnings: Database.Statement;
    getLearningsForProject: Database.Statement;
    getLearningsWithUser: Database.Statement;
    getLearningsForProjectAndUser: Database.Statement;
    hasDuplicate: Database.Statement;
    insertHistory: Database.Statement;
    getHistory: Database.Statement;
    countHistory: Database.Statement;
    pruneHistory: Database.Statement;
  };

  /** Optional embedder for generating vector embeddings on write */
  private embedder: GeminiEmbedder | null;

  /** Prepared statement for upserting embeddings */
  private upsertEmbedding: Database.Statement;

  constructor(private db: Database.Database, embedder?: GeminiEmbedder | null) {
    this.embedder = embedder ?? null;
    this.defaultUser = DEFAULT_USER;
    this.upsertEmbedding = db.prepare(
      "INSERT OR REPLACE INTO embeddings (entry_id, embedding, model, created_at, format) VALUES (?, ?, ?, ?, ?)"
    );

    // Detect FTS5 availability
    this.hasFts = !!db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_fts'"
    ).get();

    this.stmts = {
      insert: db.prepare(`
        INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details, tags, related_files, occurrences, project_count, extracted_at, user)
        VALUES (@id, @type, @project, @sessionId, @timestamp, @summary, @details, @tags, @relatedFiles, @occurrences, @projectCount, @extractedAt, @user)
      `),
      upsert: db.prepare(`
        INSERT OR REPLACE INTO knowledge (id, type, project, session_id, timestamp, summary, details, tags, related_files, occurrences, project_count, extracted_at, user)
        VALUES (@id, @type, @project, @sessionId, @timestamp, @summary, @details, @tags, @relatedFiles, @occurrences, @projectCount, @extractedAt, @user)
      `),
      getById: db.prepare("SELECT * FROM knowledge WHERE id = ?"),
      getByProject: db.prepare("SELECT * FROM knowledge WHERE LOWER(project) LIKE '%' || LOWER(?) || '%' ESCAPE '\\' ORDER BY timestamp DESC"),
      getByProjectAndUser: db.prepare("SELECT * FROM knowledge WHERE LOWER(project) LIKE '%' || LOWER(?) || '%' ESCAPE '\\' AND user = ? ORDER BY timestamp DESC"),
      getByType: db.prepare("SELECT * FROM knowledge WHERE type = ? ORDER BY timestamp DESC"),
      getByTypeAndProject: db.prepare(
        "SELECT * FROM knowledge WHERE type = ? AND LOWER(project) LIKE '%' || LOWER(?) || '%' ESCAPE '\\' ORDER BY timestamp DESC"
      ),
      getByTypeAndUser: db.prepare(
        "SELECT * FROM knowledge WHERE type = ? AND user = ? ORDER BY timestamp DESC"
      ),
      getByTypeAndProjectAndUser: db.prepare(
        "SELECT * FROM knowledge WHERE type = ? AND LOWER(project) LIKE '%' || LOWER(?) || '%' ESCAPE '\\' AND user = ? ORDER BY timestamp DESC"
      ),
      // LIKE-based fallback search statements
      searchLike: db.prepare(`
        SELECT * FROM knowledge
        WHERE LOWER(summary || ' ' || details || ' ' || COALESCE(tags, '')) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'
        ORDER BY timestamp DESC
      `),
      searchLikeWithProject: db.prepare(`
        SELECT * FROM knowledge
        WHERE LOWER(summary || ' ' || details || ' ' || COALESCE(tags, '')) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'
          AND LOWER(project) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'
        ORDER BY timestamp DESC
      `),
      searchLikeWithUser: db.prepare(`
        SELECT * FROM knowledge
        WHERE LOWER(summary || ' ' || details || ' ' || COALESCE(tags, '')) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'
          AND user = ?
        ORDER BY timestamp DESC
      `),
      searchLikeWithProjectAndUser: db.prepare(`
        SELECT * FROM knowledge
        WHERE LOWER(summary || ' ' || details || ' ' || COALESCE(tags, '')) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'
          AND LOWER(project) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'
          AND user = ?
        ORDER BY timestamp DESC
      `),
      // FTS5-based search statements (null if FTS table unavailable)
      searchFts: this.hasFts ? db.prepare(`
        SELECT k.* FROM knowledge k
          JOIN knowledge_fts fts ON k.rowid = fts.rowid
          WHERE knowledge_fts MATCH ?
          ORDER BY rank
          LIMIT 50
      `) : null,
      searchFtsWithProject: this.hasFts ? db.prepare(`
        SELECT k.* FROM knowledge k
          JOIN knowledge_fts fts ON k.rowid = fts.rowid
          WHERE knowledge_fts MATCH ? AND LOWER(k.project) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'
          ORDER BY rank
          LIMIT 50
      `) : null,
      searchFtsWithUser: this.hasFts ? db.prepare(`
        SELECT k.* FROM knowledge k
          JOIN knowledge_fts fts ON k.rowid = fts.rowid
          WHERE knowledge_fts MATCH ? AND k.user = ?
          ORDER BY rank
          LIMIT 50
      `) : null,
      searchFtsWithProjectAndUser: this.hasFts ? db.prepare(`
        SELECT k.* FROM knowledge k
          JOIN knowledge_fts fts ON k.rowid = fts.rowid
          WHERE knowledge_fts MATCH ? AND LOWER(k.project) LIKE '%' || LOWER(?) || '%' ESCAPE '\\' AND k.user = ?
          ORDER BY rank
          LIMIT 50
      `) : null,
      getAll: db.prepare("SELECT * FROM knowledge ORDER BY timestamp DESC"),
      getAllWithUser: db.prepare("SELECT * FROM knowledge WHERE user = ? ORDER BY timestamp DESC"),
      count: db.prepare("SELECT COUNT(*) as count FROM knowledge"),
      remove: db.prepare("DELETE FROM knowledge WHERE id = ?"),
      getLearnings: db.prepare(
        "SELECT * FROM knowledge WHERE type = 'learning' ORDER BY COALESCE(occurrences, 0) DESC"
      ),
      getLearningsForProject: db.prepare(
        "SELECT * FROM knowledge WHERE type = 'learning' AND LOWER(project) LIKE '%' || LOWER(?) || '%' ESCAPE '\\' ORDER BY COALESCE(occurrences, 0) DESC"
      ),
      getLearningsWithUser: db.prepare(
        "SELECT * FROM knowledge WHERE type = 'learning' AND user = ? ORDER BY COALESCE(occurrences, 0) DESC"
      ),
      getLearningsForProjectAndUser: db.prepare(
        "SELECT * FROM knowledge WHERE type = 'learning' AND LOWER(project) LIKE '%' || LOWER(?) || '%' ESCAPE '\\' AND user = ? ORDER BY COALESCE(occurrences, 0) DESC"
      ),
      hasDuplicate: db.prepare(
        "SELECT id FROM knowledge WHERE project = ? AND type = ? AND summary = ? AND user = ? LIMIT 1"
      ),
      insertHistory: db.prepare(`
        INSERT INTO knowledge_history (entry_id, old_summary, new_summary, old_details, new_details, event, created_at)
        VALUES (@entryId, @oldSummary, @newSummary, @oldDetails, @newDetails, @event, @createdAt)
      `),
      getHistory: db.prepare(
        "SELECT * FROM knowledge_history WHERE entry_id = ? ORDER BY id DESC LIMIT ?"
      ),
      countHistory: db.prepare(
        "SELECT COUNT(*) as count FROM knowledge_history WHERE entry_id = ?"
      ),
      pruneHistory: db.prepare(`
        DELETE FROM knowledge_history
        WHERE entry_id = ? AND id NOT IN (
          SELECT id FROM knowledge_history WHERE entry_id = ? ORDER BY id DESC LIMIT 100
        )
      `),
    };
  }

  /**
   * Add a knowledge entry. Skips duplicates by project+type+summary.
   * Logs an "add" event to knowledge_history (skipped for dedup rejections).
   */
  async addEntry(entry: KnowledgeEntry): Promise<void> {
    const user = entry.user || this.defaultUser;
    const dup = this.stmts.hasDuplicate.get(entry.project, entry.type, entry.summary, user);
    if (dup) return;

    const row = entryToRow(entry);
    // Debug: check for undefined values that SQLite can't bind
    for (const [k, v] of Object.entries(row)) {
      if (v === undefined) {
        console.warn(`[knowledge-store] entryToRow produced undefined for key "${k}", coercing to null`);
        (row as Record<string, unknown>)[k] = null;
      }
    }
    const addTxn = this.db.transaction(() => {
      this.stmts.insert.run(row);
      this.stmts.insertHistory.run({
        entryId: entry.id,
        oldSummary: null,
        newSummary: row.summary,
        oldDetails: null,
        newDetails: row.details,
        event: "add",
        createdAt: Date.now(),
      });
      this.pruneHistoryForEntry(entry.id);
    });
    addTxn();
    this.embedEntryAsync(entry);
  }

  /**
   * Upsert a knowledge entry (insert or replace by ID).
   */
  async upsertEntry(entry: KnowledgeEntry): Promise<void> {
    this.stmts.upsert.run(entryToRow(entry));
    this.embedEntryAsync(entry);
  }

  /**
   * Asynchronously generate and store an embedding for a knowledge entry.
   * Failures are caught and logged — never propagated to the caller.
   */
  private embedEntryAsync(entry: KnowledgeEntry): void {
    if (!this.embedder) return;

    const text = entry.summary + " " + entry.details;
    this.embedder
      .embed(text, "RETRIEVAL_DOCUMENT")
      .then((vec) => {
        let buf: Buffer;
        let format: string;

        if (CONFIG.quantization.enabled) {
          const bitWidth = CONFIG.quantization.bitWidth as 1 | 2 | 4 | 8;
          const quantized = quantize(vec, bitWidth);
          buf = Buffer.from(quantized);
          format = `tq${bitWidth}`;
        } else {
          buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
          format = "float32";
        }

        this.upsertEmbedding.run(entry.id, buf, "gemini-embedding-001", Date.now(), format);
      })
      .catch((err) => {
        console.error(`[strata] Failed to embed entry ${entry.id}:`, err);
      });
  }

  /**
   * Get an entry by ID.
   */
  async getEntry(id: string): Promise<KnowledgeEntry | undefined> {
    const row = this.stmts.getById.get(id) as SqliteKnowledgeRow | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  /**
   * Check if an entry with the given ID exists.
   */
  async hasEntry(id: string): Promise<boolean> {
    return this.stmts.getById.get(id) !== undefined;
  }

  /**
   * Search entries by query text, optionally filtered by project and/or user.
   * Uses FTS5 MATCH when available (with AND->OR fallback), falls back to LIKE.
   */
  async search(query: string, project?: string, user?: string): Promise<KnowledgeEntry[]> {
    if (this.hasFts) {
      const rows = this.searchFts(query, project, user);
      if (rows !== null) return rows.map(rowToEntry);
      // FTS query was empty after sanitization — fall through to LIKE
    }

    // LIKE fallback for databases without knowledge_fts or empty FTS query
    const safeQuery = escapeLike(query);
    let rows: SqliteKnowledgeRow[];
    if (project && user) {
      rows = this.stmts.searchLikeWithProjectAndUser.all(safeQuery, escapeLike(project), user) as SqliteKnowledgeRow[];
    } else if (project) {
      rows = this.stmts.searchLikeWithProject.all(safeQuery, escapeLike(project)) as SqliteKnowledgeRow[];
    } else if (user) {
      rows = this.stmts.searchLikeWithUser.all(safeQuery, user) as SqliteKnowledgeRow[];
    } else {
      rows = this.stmts.searchLike.all(safeQuery) as SqliteKnowledgeRow[];
    }
    return rows.map(rowToEntry);
  }

  /**
   * FTS5 search with AND->OR fallback (same pattern as SqliteDocumentStore).
   * Returns null if the sanitized query is empty (caller should fall back to LIKE).
   */
  private searchFts(query: string, project?: string, user?: string): SqliteKnowledgeRow[] | null {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return null;

    const pickStmt = (fts: Database.Statement | null) => fts!;
    let stmt: Database.Statement;
    let args: unknown[];

    if (project && user) {
      stmt = pickStmt(this.stmts.searchFtsWithProjectAndUser);
      args = [sanitized, escapeLike(project), user];
    } else if (project) {
      stmt = pickStmt(this.stmts.searchFtsWithProject);
      args = [sanitized, escapeLike(project)];
    } else if (user) {
      stmt = pickStmt(this.stmts.searchFtsWithUser);
      args = [sanitized, user];
    } else {
      stmt = pickStmt(this.stmts.searchFts);
      args = [sanitized];
    }

    try {
      const rows = stmt.all(...args) as SqliteKnowledgeRow[];

      // AND->OR fallback: if implicit-AND returned nothing for a multi-word
      // query, retry with OR so that entries matching any term are surfaced.
      if (rows.length === 0) {
        const tokens = sanitized.split(" ").filter(Boolean);
        if (tokens.length > 1) {
          const orQuery = tokens.join(" OR ");
          const orArgs = [...args];
          orArgs[0] = orQuery;
          const orRows = stmt.all(...orArgs) as SqliteKnowledgeRow[];
          return orRows;
        }
      }

      return rows;
    } catch {
      // If FTS query syntax is invalid, try as a phrase
      try {
        const phraseQuery = `"${query.replace(/"/g, '""')}"`;
        const phraseArgs = [...args];
        phraseArgs[0] = phraseQuery;
        return stmt.all(...phraseArgs) as SqliteKnowledgeRow[];
      } catch {
        return null; // Fall back to LIKE
      }
    }
  }

  /**
   * Get entries for a project, optionally filtered by user.
   */
  async getProjectEntries(project: string, user?: string): Promise<KnowledgeEntry[]> {
    const safeProject = escapeLike(project);
    const rows = user
      ? (this.stmts.getByProjectAndUser.all(safeProject, user) as SqliteKnowledgeRow[])
      : (this.stmts.getByProject.all(safeProject) as SqliteKnowledgeRow[]);
    return rows.map(rowToEntry);
  }

  /**
   * Get entries by type, optionally filtered by project and/or user.
   */
  async getByType(type: KnowledgeEntry["type"], project?: string, user?: string): Promise<KnowledgeEntry[]> {
    let rows: SqliteKnowledgeRow[];
    if (project && user) {
      rows = this.stmts.getByTypeAndProjectAndUser.all(type, escapeLike(project), user) as SqliteKnowledgeRow[];
    } else if (project) {
      rows = this.stmts.getByTypeAndProject.all(type, escapeLike(project)) as SqliteKnowledgeRow[];
    } else if (user) {
      rows = this.stmts.getByTypeAndUser.all(type, user) as SqliteKnowledgeRow[];
    } else {
      rows = this.stmts.getByType.all(type) as SqliteKnowledgeRow[];
    }
    return rows.map(rowToEntry);
  }

  /**
   * Get all learning entries, optionally filtered by project and/or user.
   */
  async getGlobalLearnings(project?: string, user?: string): Promise<KnowledgeEntry[]> {
    let rows: SqliteKnowledgeRow[];
    if (project && user) {
      rows = this.stmts.getLearningsForProjectAndUser.all(escapeLike(project), user) as SqliteKnowledgeRow[];
    } else if (project) {
      rows = this.stmts.getLearningsForProject.all(escapeLike(project)) as SqliteKnowledgeRow[];
    } else if (user) {
      rows = this.stmts.getLearningsWithUser.all(user) as SqliteKnowledgeRow[];
    } else {
      rows = this.stmts.getLearnings.all() as SqliteKnowledgeRow[];
    }
    return rows.map(rowToEntry);
  }

  /**
   * Partially update a knowledge entry by ID.
   * Only provided fields in the patch are changed; omitted fields retain current values.
   * Sets `updated_at` to the current timestamp. Logs an "update" event to history.
   *
   * @param id - The entry ID to update.
   * @param patch - Partial fields to change (summary, details, tags, type).
   * @returns true if the entry was found and updated, false if not found or patch was empty.
   */
  async updateEntry(id: string, patch: KnowledgeUpdatePatch): Promise<boolean> {
    const keys = Object.keys(patch).filter(
      (k) => patch[k as keyof KnowledgeUpdatePatch] !== undefined
    );
    if (keys.length === 0) return false;

    const row = this.stmts.getById.get(id) as SqliteKnowledgeRow | undefined;
    if (!row) return false;

    const updateTxn = this.db.transaction(() => {
      const setClauses: string[] = ["updated_at = ?"];
      const params: unknown[] = [Date.now()];

      if (patch.summary !== undefined) {
        setClauses.push("summary = ?");
        params.push(patch.summary);
      }
      if (patch.details !== undefined) {
        setClauses.push("details = ?");
        params.push(patch.details);
      }
      if (patch.tags !== undefined) {
        setClauses.push("tags = ?");
        params.push(JSON.stringify(patch.tags));
      }
      if (patch.type !== undefined) {
        setClauses.push("type = ?");
        params.push(patch.type);
      }

      params.push(id);
      // nosemgrep: sql-injection-template-literal — setClauses contains only hardcoded column-name literals from a typed KnowledgeUpdatePatch interface; user values are parameterized via ?
      this.db.prepare(`UPDATE knowledge SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);

      this.stmts.insertHistory.run({
        entryId: id,
        oldSummary: row.summary,
        newSummary: patch.summary ?? row.summary,
        oldDetails: row.details,
        newDetails: patch.details ?? row.details,
        event: "update",
        createdAt: Date.now(),
      });
      this.pruneHistoryForEntry(id);
    });
    updateTxn();
    return true;
  }

  /**
   * Hard-delete a knowledge entry by ID.
   * Records a "delete" event in knowledge_history before removing the row.
   * No-op if the entry does not exist.
   *
   * @param id - The entry ID to delete.
   * @returns true if the entry was found and deleted, false if not found.
   */
  async deleteEntry(id: string): Promise<boolean> {
    const row = this.stmts.getById.get(id) as SqliteKnowledgeRow | undefined;
    if (!row) return false;

    const deleteTxn = this.db.transaction(() => {
      this.stmts.insertHistory.run({
        entryId: id,
        oldSummary: row.summary,
        newSummary: null,
        oldDetails: row.details,
        newDetails: null,
        event: "delete",
        createdAt: Date.now(),
      });
      this.stmts.remove.run(id);
      this.pruneHistoryForEntry(id);
    });
    deleteTxn();
    return true;
  }

  /**
   * Remove an entry by ID. Delegates to deleteEntry() for audit trail.
   */
  async removeEntry(id: string): Promise<void> {
    this.deleteEntry(id);
  }

  /**
   * Get mutation history for an entry, ordered most-recent first.
   *
   * @param entryId - The entry ID to get history for.
   * @param limit - Max rows to return (default 20, max 100).
   * @returns Array of KnowledgeHistoryRow objects.
   */
  async getHistory(entryId: string, limit: number = 20): Promise<KnowledgeHistoryRow[]> {
    const effectiveLimit = Math.min(Math.max(limit, 1), 100);
    return this.stmts.getHistory.all(entryId, effectiveLimit) as KnowledgeHistoryRow[];
  }

  /** Prune history rows for an entry to keep at most 100. */
  private pruneHistoryForEntry(entryId: string): void {
    const { count } = this.stmts.countHistory.get(entryId) as { count: number };
    if (count > 100) {
      this.stmts.pruneHistory.run(entryId, entryId);
    }
  }

  /**
   * Merge a procedure entry with any existing procedure that shares the same
   * project + type + summary. Steps are unioned (case-insensitive, trimmed),
   * preserving original order first and appending new unique steps.
   * prerequisites and warnings are also merged. Occurrences is incremented.
   * If no existing entry matches, falls through to a normal insert.
   * Runs in a SQLite transaction for safety.
   */
  async mergeProcedure(entry: KnowledgeEntry): Promise<void> {
    const user = entry.user || this.defaultUser;
    const mergeTxn = this.db.transaction(() => {
      const existingRow = this.stmts.hasDuplicate.get(
        entry.project,
        entry.type,
        entry.summary,
        user
      ) as { id: string } | undefined;

      if (!existingRow) {
        // No existing entry — insert fresh
        const freshRow = entryToRow(entry);
        this.stmts.insert.run(freshRow);
        this.stmts.insertHistory.run({
          entryId: entry.id,
          oldSummary: null,
          newSummary: freshRow.summary,
          oldDetails: null,
          newDetails: freshRow.details,
          event: "add",
          createdAt: Date.now(),
        });
        return;
      }

      // Fetch existing entry
      const existingFull = this.stmts.getById.get(existingRow.id) as SqliteKnowledgeRow;
      const existing = rowToEntry(existingFull);

      // Parse existing details (gracefully handle malformed JSON)
      const existingDetails = parseProcedureDetails(existing.details);
      const newDetails = parseProcedureDetails(entry.details);

      if (!newDetails) return; // Nothing valid to merge

      const baseSteps = existingDetails?.steps ?? [];
      const mergedSteps = mergeStringArrays(baseSteps, newDetails.steps);

      // Cap at 20 steps
      const cappedSteps = mergedSteps.slice(0, 20);

      const mergedPrereqs = mergeStringArrays(
        existingDetails?.prerequisites ?? [],
        newDetails.prerequisites ?? []
      );
      const mergedWarnings = mergeStringArrays(
        existingDetails?.warnings ?? [],
        newDetails.warnings ?? []
      );

      const mergedDetailsObj: ProcedureDetails = { steps: cappedSteps };
      if (mergedPrereqs.length > 0) mergedDetailsObj.prerequisites = mergedPrereqs;
      if (mergedWarnings.length > 0) mergedDetailsObj.warnings = mergedWarnings;

      const merged: KnowledgeEntry = {
        ...existing,
        details: JSON.stringify(mergedDetailsObj),
        occurrences: (existing.occurrences ?? 1) + 1,
        tags: [...new Set([...existing.tags, ...entry.tags])],
      };

      this.stmts.upsert.run(entryToRow(merged));
      this.stmts.insertHistory.run({
        entryId: existing.id,
        oldSummary: existing.summary,
        newSummary: merged.summary,
        oldDetails: existing.details,
        newDetails: merged.details,
        event: "update",
        createdAt: Date.now(),
      });
    });
    mergeTxn();
  }

  /**
   * Get total entry count.
   */
  async getEntryCount(): Promise<number> {
    const row = this.stmts.count.get() as { count: number };
    return row.count;
  }

  /**
   * Get all entries, optionally filtered by user.
   */
  async getAllEntries(user?: string): Promise<KnowledgeEntry[]> {
    const rows = user
      ? (this.stmts.getAllWithUser.all(user) as SqliteKnowledgeRow[])
      : (this.stmts.getAll.all() as SqliteKnowledgeRow[]);
    return rows.map(rowToEntry);
  }

  /**
   * Paginated listing with filters for the dashboard.
   * Uses FTS5 MATCH for the search filter when available, with LIKE fallback.
   */
  async getEntries(options: KnowledgeListOptions): Promise<{ entries: KnowledgeEntry[]; total: number }> {
    // Determine if we can use FTS5 for the search filter
    const useFtsForSearch = this.hasFts && options.search;
    let ftsQuery: string | null = null;
    if (useFtsForSearch) {
      ftsQuery = sanitizeFtsQuery(options.search!);
      if (!ftsQuery) {
        // Sanitized to empty — fall back to LIKE for search
      }
    }

    const useJoin = useFtsForSearch && ftsQuery;

    // Build FROM clause — join with FTS when searching via FTS5
    const fromClause = useJoin
      ? "knowledge k JOIN knowledge_fts fts ON k.rowid = fts.rowid"
      : "knowledge k";

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (useJoin) {
      conditions.push("knowledge_fts MATCH ?");
      params.push(ftsQuery!);
    }

    if (options.type) {
      conditions.push("k.type = ?");
      params.push(options.type);
    }

    if (options.project) {
      conditions.push("LOWER(k.project) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'");
      params.push(escapeLike(options.project));
    }

    if (options.search && !useJoin) {
      // LIKE fallback when FTS is unavailable or query sanitized to empty
      conditions.push(
        "LOWER(k.summary || ' ' || k.details || ' ' || COALESCE(k.tags, '')) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'"
      );
      params.push(escapeLike(options.search));
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    let orderBy: string;
    switch (options.sort) {
      case "oldest":
        orderBy = "ORDER BY k.timestamp ASC";
        break;
      case "importance":
        orderBy = "ORDER BY COALESCE(k.importance, 0) DESC";
        break;
      case "newest":
      default:
        orderBy = "ORDER BY k.timestamp DESC";
        break;
    }

    const countRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM ${fromClause} ${where}`)
      .get(...params) as { count: number };

    const rows = this.db
      .prepare(`SELECT k.* FROM ${fromClause} ${where} ${orderBy} LIMIT ? OFFSET ?`)
      .all(...params, options.limit, options.offset) as SqliteKnowledgeRow[];

    return { entries: rows.map(rowToEntry), total: countRow.count };
  }

  /**
   * Aggregate knowledge counts by type, optionally filtered by project.
   */
  async getTypeDistribution(project?: string): Promise<Record<string, number>> {
    let rows: Array<{ type: string; count: number }>;

    if (project) {
      rows = this.db
        .prepare("SELECT type, COUNT(*) as count FROM knowledge WHERE project = ? GROUP BY type")
        .all(project) as Array<{ type: string; count: number }>;
    } else {
      rows = this.db
        .prepare("SELECT type, COUNT(*) as count FROM knowledge GROUP BY type")
        .all() as Array<{ type: string; count: number }>;
    }

    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.type] = row.count;
    }
    return result;
  }
}

// --- Internal helpers ---

interface SqliteKnowledgeRow {
  id: string;
  type: string;
  project: string;
  session_id: string;
  timestamp: number;
  summary: string;
  details: string;
  tags: string | null;
  related_files: string | null;
  occurrences: number | null;
  project_count: number | null;
  extracted_at: number | null;
  updated_at: number | null;
  user: string;
  importance: number | null;
}

function rowToEntry(row: SqliteKnowledgeRow): KnowledgeEntry {
  return {
    id: row.id,
    type: row.type as KnowledgeEntry["type"],
    project: row.project,
    user: row.user,
    sessionId: row.session_id,
    timestamp: row.timestamp,
    summary: row.summary,
    details: row.details,
    tags: row.tags ? JSON.parse(row.tags) : [],
    relatedFiles: row.related_files ? JSON.parse(row.related_files) : [],
    occurrences: row.occurrences ?? undefined,
    projectCount: row.project_count ?? undefined,
    extractedAt: row.extracted_at ?? undefined,
    importance: row.importance ?? undefined,
  };
}

/**
 * Merge two string arrays: preserve original order, append new unique items.
 * Dedup is case-insensitive and trims whitespace.
 */
function mergeStringArrays(base: string[], incoming: string[]): string[] {
  const seen = new Set(base.map((s) => s.trim().toLowerCase()));
  const result = [...base];
  for (const item of incoming) {
    const key = item.trim().toLowerCase();
    if (key.length > 0 && !seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

function entryToRow(entry: KnowledgeEntry): Record<string, unknown> {
  // Coerce details to string — LLM extraction may return objects or undefined
  const details =
    entry.details === undefined || entry.details === null
      ? ""
      : typeof entry.details === "string"
        ? entry.details
        : JSON.stringify(entry.details);

  return {
    id: entry.id,
    type: entry.type,
    project: entry.project,
    user: entry.user || DEFAULT_USER,
    sessionId: entry.sessionId,
    timestamp: entry.timestamp,
    summary: entry.summary || "",
    details,
    tags: JSON.stringify(entry.tags ?? []),
    relatedFiles: JSON.stringify(entry.relatedFiles ?? []),
    occurrences: entry.occurrences ?? null,
    projectCount: entry.projectCount ?? null,
    extractedAt: entry.extractedAt ?? null,
  };
}
