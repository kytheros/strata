/**
 * SQLite-backed knowledge store.
 * Replaces the JSON file-based KnowledgeStore with SQLite persistence.
 */

import type Database from "better-sqlite3";
import type { KnowledgeEntry } from "../knowledge/knowledge-store.js";
import { parseProcedureDetails } from "../knowledge/procedure-extractor.js";
import type { ProcedureDetails } from "../knowledge/procedure-extractor.js";
import type { GeminiEmbedder } from "../extensions/embeddings/gemini-embedder.js";

/** Partial update fields for a knowledge entry. */
export interface KnowledgeUpdatePatch {
  summary?: string;
  details?: string;
  tags?: string[];
  type?: KnowledgeEntry["type"];
}

/** A row from the knowledge_history table. */
export interface KnowledgeHistoryRow {
  id: number;
  entry_id: string;
  old_summary: string | null;
  new_summary: string | null;
  old_details: string | null;
  new_details: string | null;
  event: "add" | "update" | "delete";
  created_at: number;
}

/** Default user value resolved from env. */
const DEFAULT_USER = process.env.STRATA_DEFAULT_USER || "default";

/** Escape SQL LIKE wildcards (% and _) in user input to prevent pattern injection. */
function escapeLike(input: string): string {
  return input.replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export class SqliteKnowledgeStore {
  private defaultUser: string;
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
    search: Database.Statement;
    searchWithProject: Database.Statement;
    searchWithUser: Database.Statement;
    searchWithProjectAndUser: Database.Statement;
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
      "INSERT OR REPLACE INTO embeddings (entry_id, embedding, model, created_at) VALUES (?, ?, ?, ?)"
    );
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
      search: db.prepare(`
        SELECT * FROM knowledge
        WHERE LOWER(summary || ' ' || details || ' ' || COALESCE(tags, '')) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'
        ORDER BY timestamp DESC
      `),
      searchWithProject: db.prepare(`
        SELECT * FROM knowledge
        WHERE LOWER(summary || ' ' || details || ' ' || COALESCE(tags, '')) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'
          AND LOWER(project) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'
        ORDER BY timestamp DESC
      `),
      searchWithUser: db.prepare(`
        SELECT * FROM knowledge
        WHERE LOWER(summary || ' ' || details || ' ' || COALESCE(tags, '')) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'
          AND user = ?
        ORDER BY timestamp DESC
      `),
      searchWithProjectAndUser: db.prepare(`
        SELECT * FROM knowledge
        WHERE LOWER(summary || ' ' || details || ' ' || COALESCE(tags, '')) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'
          AND LOWER(project) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'
          AND user = ?
        ORDER BY timestamp DESC
      `),
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
  addEntry(entry: KnowledgeEntry): void {
    const user = entry.user || this.defaultUser;
    const dup = this.stmts.hasDuplicate.get(entry.project, entry.type, entry.summary, user);
    if (dup) return;

    const addTxn = this.db.transaction(() => {
      this.stmts.insert.run(entryToRow(entry));
      this.stmts.insertHistory.run({
        entryId: entry.id,
        oldSummary: null,
        newSummary: entry.summary,
        oldDetails: null,
        newDetails: entry.details,
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
  upsertEntry(entry: KnowledgeEntry): void {
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
      .embed(text)
      .then((vec) => {
        // Serialize Float32Array to Buffer for BLOB storage
        const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
        this.upsertEmbedding.run(entry.id, buf, "gemini-embedding-001", Date.now());
      })
      .catch((err) => {
        console.error(`[strata] Failed to embed entry ${entry.id}:`, err);
      });
  }

  /**
   * Get an entry by ID.
   */
  getEntry(id: string): KnowledgeEntry | undefined {
    const row = this.stmts.getById.get(id) as SqliteKnowledgeRow | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  /**
   * Check if an entry with the given ID exists.
   */
  hasEntry(id: string): boolean {
    return this.stmts.getById.get(id) !== undefined;
  }

  /**
   * Search entries by query text, optionally filtered by project and/or user.
   */
  search(query: string, project?: string, user?: string): KnowledgeEntry[] {
    const safeQuery = escapeLike(query);
    let rows: SqliteKnowledgeRow[];
    if (project && user) {
      rows = this.stmts.searchWithProjectAndUser.all(safeQuery, escapeLike(project), user) as SqliteKnowledgeRow[];
    } else if (project) {
      rows = this.stmts.searchWithProject.all(safeQuery, escapeLike(project)) as SqliteKnowledgeRow[];
    } else if (user) {
      rows = this.stmts.searchWithUser.all(safeQuery, user) as SqliteKnowledgeRow[];
    } else {
      rows = this.stmts.search.all(safeQuery) as SqliteKnowledgeRow[];
    }
    return rows.map(rowToEntry);
  }

  /**
   * Get entries for a project, optionally filtered by user.
   */
  getProjectEntries(project: string, user?: string): KnowledgeEntry[] {
    const safeProject = escapeLike(project);
    const rows = user
      ? (this.stmts.getByProjectAndUser.all(safeProject, user) as SqliteKnowledgeRow[])
      : (this.stmts.getByProject.all(safeProject) as SqliteKnowledgeRow[]);
    return rows.map(rowToEntry);
  }

  /**
   * Get entries by type, optionally filtered by project and/or user.
   */
  getByType(type: KnowledgeEntry["type"], project?: string, user?: string): KnowledgeEntry[] {
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
  getGlobalLearnings(project?: string, user?: string): KnowledgeEntry[] {
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
  updateEntry(id: string, patch: KnowledgeUpdatePatch): boolean {
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
  deleteEntry(id: string): boolean {
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
  removeEntry(id: string): void {
    this.deleteEntry(id);
  }

  /**
   * Get mutation history for an entry, ordered most-recent first.
   *
   * @param entryId - The entry ID to get history for.
   * @param limit - Max rows to return (default 20, max 100).
   * @returns Array of KnowledgeHistoryRow objects.
   */
  getHistory(entryId: string, limit: number = 20): KnowledgeHistoryRow[] {
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
  mergeProcedure(entry: KnowledgeEntry): void {
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
        this.stmts.insert.run(entryToRow(entry));
        this.stmts.insertHistory.run({
          entryId: entry.id,
          oldSummary: null,
          newSummary: entry.summary,
          oldDetails: null,
          newDetails: entry.details,
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
  getEntryCount(): number {
    const row = this.stmts.count.get() as { count: number };
    return row.count;
  }

  /**
   * Get all entries, optionally filtered by user.
   */
  getAllEntries(user?: string): KnowledgeEntry[] {
    const rows = user
      ? (this.stmts.getAllWithUser.all(user) as SqliteKnowledgeRow[])
      : (this.stmts.getAll.all() as SqliteKnowledgeRow[]);
    return rows.map(rowToEntry);
  }

  /**
   * Paginated listing with filters for the dashboard.
   */
  getEntries(options: {
    type?: string;
    project?: string;
    search?: string;
    sort?: "newest" | "oldest" | "importance";
    limit: number;
    offset: number;
  }): { entries: KnowledgeEntry[]; total: number } {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.type) {
      conditions.push("type = ?");
      params.push(options.type);
    }

    if (options.project) {
      conditions.push("LOWER(project) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'");
      params.push(escapeLike(options.project));
    }

    if (options.search) {
      conditions.push(
        "LOWER(summary || ' ' || details || ' ' || COALESCE(tags, '')) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'"
      );
      params.push(escapeLike(options.search));
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    let orderBy: string;
    switch (options.sort) {
      case "oldest":
        orderBy = "ORDER BY timestamp ASC";
        break;
      case "importance":
        orderBy = "ORDER BY COALESCE(importance, 0) DESC";
        break;
      case "newest":
      default:
        orderBy = "ORDER BY timestamp DESC";
        break;
    }

    const countRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM knowledge ${where}`)
      .get(...params) as { count: number };

    const rows = this.db
      .prepare(`SELECT * FROM knowledge ${where} ${orderBy} LIMIT ? OFFSET ?`)
      .all(...params, options.limit, options.offset) as SqliteKnowledgeRow[];

    return { entries: rows.map(rowToEntry), total: countRow.count };
  }

  /**
   * Aggregate knowledge counts by type, optionally filtered by project.
   */
  getTypeDistribution(project?: string): Record<string, number> {
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
  return {
    id: entry.id,
    type: entry.type,
    project: entry.project,
    user: entry.user || DEFAULT_USER,
    sessionId: entry.sessionId,
    timestamp: entry.timestamp,
    summary: entry.summary,
    details: entry.details,
    tags: JSON.stringify(entry.tags),
    relatedFiles: JSON.stringify(entry.relatedFiles),
    occurrences: entry.occurrences ?? null,
    projectCount: entry.projectCount ?? null,
    extractedAt: entry.extractedAt ?? null,
  };
}
