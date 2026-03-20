/**
 * D1-backed knowledge store.
 *
 * Implements IKnowledgeStore using Cloudflare D1 async APIs.
 * Mirrors SqliteKnowledgeStore method-for-method.
 *
 * Key D1 differences from better-sqlite3:
 *   - All operations are async (Promise-based)
 *   - Transactions use db.batch() instead of db.transaction()
 *   - No prepared statement caching — prepare() returns a fresh statement each time
 *   - All queries include `WHERE user = ?` for multi-tenant row isolation
 */

import type { D1Database } from "./d1-types.js";
import type { KnowledgeEntry } from "../../knowledge/knowledge-store.js";
import type {
  IKnowledgeStore,
  KnowledgeUpdatePatch,
  KnowledgeHistoryRow,
  KnowledgeListOptions,
} from "../interfaces/index.js";
import { parseProcedureDetails } from "../../knowledge/procedure-extractor.js";
import type { ProcedureDetails } from "../../knowledge/procedure-extractor.js";

/** Row shape returned from D1 queries against the knowledge table. */
interface D1KnowledgeRow {
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

/** Escape SQL LIKE wildcards (% and _) in user input to prevent pattern injection. */
function escapeLike(input: string): string {
  return input.replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function rowToEntry(row: D1KnowledgeRow): KnowledgeEntry {
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

function entryToParams(entry: KnowledgeEntry, defaultUser: string): unknown[] {
  return [
    entry.id,
    entry.type,
    entry.project,
    entry.sessionId,
    entry.timestamp,
    entry.summary,
    entry.details,
    JSON.stringify(entry.tags),
    JSON.stringify(entry.relatedFiles),
    entry.occurrences ?? null,
    entry.projectCount ?? null,
    entry.extractedAt ?? null,
    entry.user || defaultUser,
  ];
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

export class D1KnowledgeStore implements IKnowledgeStore {
  private userId: string;

  constructor(
    private db: D1Database,
    userId: string,
    private embedder?: { embed(text: string, taskType: string): Promise<Float32Array> } | null,
  ) {
    this.userId = userId;
  }

  async addEntry(entry: KnowledgeEntry): Promise<void> {
    const user = entry.user || this.userId;

    // Check for duplicate by project+type+summary+user
    const dup = await this.db
      .prepare("SELECT id FROM knowledge WHERE project = ? AND type = ? AND summary = ? AND user = ? LIMIT 1")
      .bind(entry.project, entry.type, entry.summary, user)
      .first<{ id: string }>();
    if (dup) return;

    // Insert entry + history in a batch (atomic)
    await this.db.batch([
      this.db
        .prepare(`
          INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details, tags, related_files, occurrences, project_count, extracted_at, user)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(...entryToParams(entry, this.userId)),
      this.db
        .prepare(`
          INSERT INTO knowledge_history (entry_id, old_summary, new_summary, old_details, new_details, event, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(entry.id, null, entry.summary, null, entry.details, "add", Date.now()),
    ]);

    await this.pruneHistoryForEntry(entry.id);
    this.embedEntryAsync(entry);
  }

  async upsertEntry(entry: KnowledgeEntry): Promise<void> {
    await this.db
      .prepare(`
        INSERT OR REPLACE INTO knowledge (id, type, project, session_id, timestamp, summary, details, tags, related_files, occurrences, project_count, extracted_at, user)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(...entryToParams(entry, this.userId))
      .run();

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
      .then(async (vec) => {
        // Serialize Float32Array to ArrayBuffer for BLOB storage
        const buf = vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength);
        await this.db
          .prepare(
            "INSERT OR REPLACE INTO embeddings (id, embedding, model, created_at) VALUES (?, ?, ?, ?)"
          )
          .bind(entry.id, buf, "gemini-embedding-001", Date.now())
          .run();
      })
      .catch((err) => {
        console.error(`[strata-d1] Failed to embed entry ${entry.id}:`, err);
      });
  }

  async getEntry(id: string): Promise<KnowledgeEntry | undefined> {
    const row = await this.db
      .prepare("SELECT * FROM knowledge WHERE id = ? AND user = ?")
      .bind(id, this.userId)
      .first<D1KnowledgeRow>();
    return row ? rowToEntry(row) : undefined;
  }

  async hasEntry(id: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT id FROM knowledge WHERE id = ? AND user = ?")
      .bind(id, this.userId)
      .first<{ id: string }>();
    return row !== null;
  }

  async search(query: string, project?: string, user?: string): Promise<KnowledgeEntry[]> {
    const safeQuery = escapeLike(query);
    const effectiveUser = user ?? this.userId;
    let sql = `SELECT * FROM knowledge WHERE user = ? AND LOWER(summary || ' ' || details || ' ' || COALESCE(tags, '')) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'`;
    const params: unknown[] = [effectiveUser, safeQuery];

    if (project) {
      sql += ` AND LOWER(project) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'`;
      params.push(escapeLike(project));
    }

    sql += " ORDER BY timestamp DESC";

    const result = await this.db.prepare(sql).bind(...params).all<D1KnowledgeRow>();
    return result.results.map(rowToEntry);
  }

  async getProjectEntries(project: string, user?: string): Promise<KnowledgeEntry[]> {
    const effectiveUser = user ?? this.userId;
    const safeProject = escapeLike(project);
    const result = await this.db
      .prepare(
        `SELECT * FROM knowledge WHERE user = ? AND LOWER(project) LIKE '%' || LOWER(?) || '%' ESCAPE '\\' ORDER BY timestamp DESC`
      )
      .bind(effectiveUser, safeProject)
      .all<D1KnowledgeRow>();
    return result.results.map(rowToEntry);
  }

  async getByType(type: KnowledgeEntry["type"], project?: string, user?: string): Promise<KnowledgeEntry[]> {
    const effectiveUser = user ?? this.userId;
    let sql = "SELECT * FROM knowledge WHERE user = ? AND type = ?";
    const params: unknown[] = [effectiveUser, type];

    if (project) {
      sql += ` AND LOWER(project) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'`;
      params.push(escapeLike(project));
    }

    sql += " ORDER BY timestamp DESC";

    const result = await this.db.prepare(sql).bind(...params).all<D1KnowledgeRow>();
    return result.results.map(rowToEntry);
  }

  async getGlobalLearnings(project?: string, user?: string): Promise<KnowledgeEntry[]> {
    const effectiveUser = user ?? this.userId;
    let sql = "SELECT * FROM knowledge WHERE user = ? AND type = 'learning'";
    const params: unknown[] = [effectiveUser];

    if (project) {
      sql += ` AND LOWER(project) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'`;
      params.push(escapeLike(project));
    }

    sql += " ORDER BY COALESCE(occurrences, 0) DESC";

    const result = await this.db.prepare(sql).bind(...params).all<D1KnowledgeRow>();
    return result.results.map(rowToEntry);
  }

  async updateEntry(id: string, patch: KnowledgeUpdatePatch): Promise<boolean> {
    const keys = Object.keys(patch).filter(
      (k) => patch[k as keyof KnowledgeUpdatePatch] !== undefined
    );
    if (keys.length === 0) return false;

    const row = await this.db
      .prepare("SELECT * FROM knowledge WHERE id = ? AND user = ?")
      .bind(id, this.userId)
      .first<D1KnowledgeRow>();
    if (!row) return false;

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

    params.push(id, this.userId);

    await this.db.batch([
      this.db
        .prepare(`UPDATE knowledge SET ${setClauses.join(", ")} WHERE id = ? AND user = ?`)
        .bind(...params),
      this.db
        .prepare(`
          INSERT INTO knowledge_history (entry_id, old_summary, new_summary, old_details, new_details, event, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          id,
          row.summary,
          patch.summary ?? row.summary,
          row.details,
          patch.details ?? row.details,
          "update",
          Date.now()
        ),
    ]);

    await this.pruneHistoryForEntry(id);
    return true;
  }

  async deleteEntry(id: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT * FROM knowledge WHERE id = ? AND user = ?")
      .bind(id, this.userId)
      .first<D1KnowledgeRow>();
    if (!row) return false;

    await this.db.batch([
      this.db
        .prepare(`
          INSERT INTO knowledge_history (entry_id, old_summary, new_summary, old_details, new_details, event, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(id, row.summary, null, row.details, null, "delete", Date.now()),
      this.db
        .prepare("DELETE FROM knowledge WHERE id = ? AND user = ?")
        .bind(id, this.userId),
    ]);

    await this.pruneHistoryForEntry(id);
    return true;
  }

  async removeEntry(id: string): Promise<void> {
    await this.deleteEntry(id);
  }

  async getHistory(entryId: string, limit: number = 20): Promise<KnowledgeHistoryRow[]> {
    const effectiveLimit = Math.min(Math.max(limit, 1), 100);
    const result = await this.db
      .prepare("SELECT * FROM knowledge_history WHERE entry_id = ? ORDER BY id DESC LIMIT ?")
      .bind(entryId, effectiveLimit)
      .all<KnowledgeHistoryRow>();
    return result.results;
  }

  /** Prune history rows for an entry to keep at most 100. */
  private async pruneHistoryForEntry(entryId: string): Promise<void> {
    const countRow = await this.db
      .prepare("SELECT COUNT(*) as count FROM knowledge_history WHERE entry_id = ?")
      .bind(entryId)
      .first<{ count: number }>();
    if (countRow && countRow.count > 100) {
      await this.db
        .prepare(`
          DELETE FROM knowledge_history
          WHERE entry_id = ? AND id NOT IN (
            SELECT id FROM knowledge_history WHERE entry_id = ? ORDER BY id DESC LIMIT 100
          )
        `)
        .bind(entryId, entryId)
        .run();
    }
  }

  async mergeProcedure(entry: KnowledgeEntry): Promise<void> {
    const user = entry.user || this.userId;

    const existingRow = await this.db
      .prepare("SELECT id FROM knowledge WHERE project = ? AND type = ? AND summary = ? AND user = ? LIMIT 1")
      .bind(entry.project, entry.type, entry.summary, user)
      .first<{ id: string }>();

    if (!existingRow) {
      // No existing entry — insert fresh
      await this.db.batch([
        this.db
          .prepare(`
            INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details, tags, related_files, occurrences, project_count, extracted_at, user)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .bind(...entryToParams(entry, this.userId)),
        this.db
          .prepare(`
            INSERT INTO knowledge_history (entry_id, old_summary, new_summary, old_details, new_details, event, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `)
          .bind(entry.id, null, entry.summary, null, entry.details, "add", Date.now()),
      ]);
      return;
    }

    // Fetch existing entry (scoped to user for safety)
    const existingFull = await this.db
      .prepare("SELECT * FROM knowledge WHERE id = ? AND user = ?")
      .bind(existingRow.id, user)
      .first<D1KnowledgeRow>();
    if (!existingFull) return;

    const existing = rowToEntry(existingFull);

    // Parse existing details (gracefully handle malformed JSON)
    const existingDetails = parseProcedureDetails(existing.details);
    const newDetails = parseProcedureDetails(entry.details);

    if (!newDetails) return; // Nothing valid to merge

    const baseSteps = existingDetails?.steps ?? [];
    const mergedSteps = mergeStringArrays(baseSteps, newDetails.steps);
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

    await this.db.batch([
      this.db
        .prepare(`
          INSERT OR REPLACE INTO knowledge (id, type, project, session_id, timestamp, summary, details, tags, related_files, occurrences, project_count, extracted_at, user)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(...entryToParams(merged, this.userId)),
      this.db
        .prepare(`
          INSERT INTO knowledge_history (entry_id, old_summary, new_summary, old_details, new_details, event, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          existing.id,
          existing.summary,
          merged.summary,
          existing.details,
          merged.details,
          "update",
          Date.now()
        ),
    ]);
  }

  async getEntryCount(): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) as count FROM knowledge WHERE user = ?")
      .bind(this.userId)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  async getAllEntries(user?: string): Promise<KnowledgeEntry[]> {
    const effectiveUser = user ?? this.userId;
    const result = await this.db
      .prepare("SELECT * FROM knowledge WHERE user = ? ORDER BY timestamp DESC")
      .bind(effectiveUser)
      .all<D1KnowledgeRow>();
    return result.results.map(rowToEntry);
  }

  async getEntries(options: KnowledgeListOptions): Promise<{ entries: KnowledgeEntry[]; total: number }> {
    const conditions: string[] = ["user = ?"];
    const params: unknown[] = [this.userId];

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

    const where = `WHERE ${conditions.join(" AND ")}`;

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

    const countRow = await this.db
      .prepare(`SELECT COUNT(*) as count FROM knowledge ${where}`)
      .bind(...params)
      .first<{ count: number }>();

    const result = await this.db
      .prepare(`SELECT * FROM knowledge ${where} ${orderBy} LIMIT ? OFFSET ?`)
      .bind(...params, options.limit, options.offset)
      .all<D1KnowledgeRow>();

    return { entries: result.results.map(rowToEntry), total: countRow?.count ?? 0 };
  }

  async getTypeDistribution(project?: string): Promise<Record<string, number>> {
    let sql: string;
    let params: unknown[];

    if (project) {
      sql = "SELECT type, COUNT(*) as count FROM knowledge WHERE user = ? AND project = ? GROUP BY type";
      params = [this.userId, project];
    } else {
      sql = "SELECT type, COUNT(*) as count FROM knowledge WHERE user = ? GROUP BY type";
      params = [this.userId];
    }

    const result = await this.db.prepare(sql).bind(...params).all<{ type: string; count: number }>();

    const out: Record<string, number> = {};
    for (const row of result.results) {
      out[row.type] = row.count;
    }
    return out;
  }
}
