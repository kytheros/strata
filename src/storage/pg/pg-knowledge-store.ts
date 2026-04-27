/**
 * Postgres-backed knowledge store.
 *
 * Implements IKnowledgeStore using pg Pool async APIs.
 * Uses weighted tsvector (summary=A, details=B, tags=C) with ts_rank for search.
 * Transactions use BEGIN/COMMIT/ROLLBACK with pooled clients.
 */

import type { PgPool, PgClient } from "./pg-types.js";
import type { KnowledgeEntry } from "../../knowledge/knowledge-store.js";
import type {
  IKnowledgeStore,
  KnowledgeUpdatePatch,
  KnowledgeHistoryRow,
  KnowledgeListOptions,
} from "../interfaces/index.js";
import { parseProcedureDetails } from "../../knowledge/procedure-extractor.js";
import type { ProcedureDetails } from "../../knowledge/procedure-extractor.js";

/** Row shape returned from Postgres queries against the knowledge table. */
interface PgKnowledgeRow {
  id: string;
  type: string;
  project: string;
  session_id: string;
  timestamp: string; // bigint comes as string
  summary: string;
  details: string;
  tags: string | null;
  related_files: string | null;
  occurrences: number | null;
  project_count: number | null;
  extracted_at: string | null;
  updated_at: string | null;
  user_scope: string;
  importance: number | null;
}

function rowToEntry(row: PgKnowledgeRow): KnowledgeEntry {
  return {
    id: row.id,
    type: row.type as KnowledgeEntry["type"],
    project: row.project,
    user: row.user_scope,
    sessionId: row.session_id,
    timestamp: Number(row.timestamp),
    summary: row.summary,
    details: row.details,
    tags: row.tags ? JSON.parse(row.tags) : [],
    relatedFiles: row.related_files ? JSON.parse(row.related_files) : [],
    occurrences: row.occurrences ?? undefined,
    projectCount: row.project_count ?? undefined,
    extractedAt: row.extracted_at ? Number(row.extracted_at) : undefined,
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

export class PgKnowledgeStore implements IKnowledgeStore {
  private userId: string;

  constructor(
    private pool: PgPool,
    userId: string,
    private embedder?: { embed(text: string, taskType: string): Promise<Float32Array> } | null,
  ) {
    this.userId = userId;
  }

  async addEntry(entry: KnowledgeEntry): Promise<void> {
    const user = entry.user || this.userId;

    // Check for duplicate by project+type+summary+user
    const { rows: dupRows } = await this.pool.query(
      "SELECT id FROM knowledge WHERE project = $1 AND type = $2 AND summary = $3 AND user_scope = $4 LIMIT 1",
      [entry.project, entry.type, entry.summary, user]
    );
    if (dupRows.length > 0) return;

    // Insert entry + history in a transaction
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details, tags, related_files, occurrences, project_count, extracted_at, user_scope)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          entry.id, entry.type, entry.project, entry.sessionId, entry.timestamp,
          entry.summary, entry.details, JSON.stringify(entry.tags),
          JSON.stringify(entry.relatedFiles), entry.occurrences ?? null,
          entry.projectCount ?? null, entry.extractedAt ?? null, user,
        ]
      );
      await client.query(
        `INSERT INTO knowledge_history (entry_id, old_summary, new_summary, old_details, new_details, event, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [entry.id, null, entry.summary, null, entry.details, "add", Date.now()]
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    await this.pruneHistoryForEntry(entry.id);
    this.embedEntryAsync(entry);
  }

  async upsertEntry(entry: KnowledgeEntry): Promise<void> {
    const user = entry.user || this.userId;
    await this.pool.query(
      `INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details, tags, related_files, occurrences, project_count, extracted_at, user_scope)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (id) DO UPDATE SET
         type = $2, project = $3, session_id = $4, timestamp = $5,
         summary = $6, details = $7, tags = $8, related_files = $9,
         occurrences = $10, project_count = $11, extracted_at = $12, user_scope = $13`,
      [
        entry.id, entry.type, entry.project, entry.sessionId, entry.timestamp,
        entry.summary, entry.details, JSON.stringify(entry.tags),
        JSON.stringify(entry.relatedFiles), entry.occurrences ?? null,
        entry.projectCount ?? null, entry.extractedAt ?? null, user,
      ]
    );

    this.embedEntryAsync(entry);
  }

  /**
   * Asynchronously generate and store an embedding for a knowledge entry.
   * Failures are caught and logged -- never propagated to the caller.
   */
  private embedEntryAsync(entry: KnowledgeEntry): void {
    if (!this.embedder) return;

    const text = entry.summary + " " + entry.details;
    this.embedder
      .embed(text, "RETRIEVAL_DOCUMENT")
      .then(async (vec) => {
        const embeddingData = Buffer.from(
          vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength)
        );
        await this.pool.query(
          `INSERT INTO embeddings (id, embedding, model, created_at, format)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO UPDATE SET embedding = $2, model = $3, created_at = $4, format = $5`,
          [entry.id, embeddingData, "gemini-embedding-001", Date.now(), "float32"]
        );
      })
      .catch((err) => {
        console.error(`[strata-pg] Failed to embed entry ${entry.id}:`, err);
      });
  }

  async getEntry(id: string): Promise<KnowledgeEntry | undefined> {
    const { rows } = await this.pool.query<PgKnowledgeRow>(
      "SELECT * FROM knowledge WHERE id = $1 AND user_scope = $2",
      [id, this.userId]
    );
    return rows.length > 0 ? rowToEntry(rows[0]) : undefined;
  }

  async hasEntry(id: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      "SELECT id FROM knowledge WHERE id = $1 AND user_scope = $2",
      [id, this.userId]
    );
    return rows.length > 0;
  }

  async search(query: string, project?: string, user?: string): Promise<KnowledgeEntry[]> {
    const effectiveUser = user ?? this.userId;

    // First try tsvector search
    let sql = `SELECT *, ts_rank(tsv, plainto_tsquery('english', $1)) AS rank
               FROM knowledge
               WHERE user_scope = $2 AND tsv @@ plainto_tsquery('english', $1)`;
    const params: unknown[] = [query, effectiveUser];
    let paramIdx = 3;

    if (project) {
      sql += ` AND LOWER(project) LIKE '%' || LOWER($${paramIdx}) || '%'`;
      params.push(project);
      paramIdx++;
    }

    sql += " ORDER BY rank DESC";

    const { rows } = await this.pool.query<PgKnowledgeRow>(sql, params);

    if (rows.length > 0) {
      return rows.map(rowToEntry);
    }

    // Fallback: ILIKE text search (catches things tsvector misses)
    let fallbackSql = `SELECT * FROM knowledge
                       WHERE user_scope = $1
                         AND (LOWER(summary || ' ' || details || ' ' || COALESCE(tags, '')) LIKE '%' || LOWER($2) || '%')`;
    const fallbackParams: unknown[] = [effectiveUser, query];
    let fbIdx = 3;

    if (project) {
      fallbackSql += ` AND LOWER(project) LIKE '%' || LOWER($${fbIdx}) || '%'`;
      fallbackParams.push(project);
    }

    fallbackSql += " ORDER BY timestamp DESC";

    const { rows: fallbackRows } = await this.pool.query<PgKnowledgeRow>(
      fallbackSql, fallbackParams
    );
    return fallbackRows.map(rowToEntry);
  }

  async getProjectEntries(project: string, user?: string): Promise<KnowledgeEntry[]> {
    const effectiveUser = user ?? this.userId;
    const { rows } = await this.pool.query<PgKnowledgeRow>(
      `SELECT * FROM knowledge WHERE user_scope = $1 AND LOWER(project) LIKE '%' || LOWER($2) || '%' ORDER BY timestamp DESC`,
      [effectiveUser, project]
    );
    return rows.map(rowToEntry);
  }

  async getByType(type: KnowledgeEntry["type"], project?: string, user?: string): Promise<KnowledgeEntry[]> {
    const effectiveUser = user ?? this.userId;
    if (project) {
      const { rows } = await this.pool.query<PgKnowledgeRow>(
        `SELECT * FROM knowledge WHERE user_scope = $1 AND type = $2 AND LOWER(project) LIKE '%' || LOWER($3) || '%' ORDER BY timestamp DESC`,
        [effectiveUser, type, project]
      );
      return rows.map(rowToEntry);
    }
    const { rows } = await this.pool.query<PgKnowledgeRow>(
      "SELECT * FROM knowledge WHERE user_scope = $1 AND type = $2 ORDER BY timestamp DESC",
      [effectiveUser, type]
    );
    return rows.map(rowToEntry);
  }

  async getGlobalLearnings(project?: string, user?: string): Promise<KnowledgeEntry[]> {
    const effectiveUser = user ?? this.userId;
    if (project) {
      const { rows } = await this.pool.query<PgKnowledgeRow>(
        `SELECT * FROM knowledge WHERE user_scope = $1 AND type = 'learning' AND LOWER(project) LIKE '%' || LOWER($2) || '%' ORDER BY COALESCE(occurrences, 0) DESC`,
        [effectiveUser, project]
      );
      return rows.map(rowToEntry);
    }
    const { rows } = await this.pool.query<PgKnowledgeRow>(
      "SELECT * FROM knowledge WHERE user_scope = $1 AND type = 'learning' ORDER BY COALESCE(occurrences, 0) DESC",
      [effectiveUser]
    );
    return rows.map(rowToEntry);
  }

  async updateEntry(id: string, patch: KnowledgeUpdatePatch): Promise<boolean> {
    const keys = Object.keys(patch).filter(
      (k) => patch[k as keyof KnowledgeUpdatePatch] !== undefined
    );
    if (keys.length === 0) return false;

    const { rows: existing } = await this.pool.query<PgKnowledgeRow>(
      "SELECT * FROM knowledge WHERE id = $1 AND user_scope = $2",
      [id, this.userId]
    );
    if (existing.length === 0) return false;

    const row = existing[0];

    const setClauses: string[] = ["updated_at = $1"];
    const params: unknown[] = [Date.now()];
    let paramIdx = 2;

    if (patch.summary !== undefined) {
      setClauses.push(`summary = $${paramIdx}`);
      params.push(patch.summary);
      paramIdx++;
    }
    if (patch.details !== undefined) {
      setClauses.push(`details = $${paramIdx}`);
      params.push(patch.details);
      paramIdx++;
    }
    if (patch.tags !== undefined) {
      setClauses.push(`tags = $${paramIdx}`);
      params.push(JSON.stringify(patch.tags));
      paramIdx++;
    }
    if (patch.type !== undefined) {
      setClauses.push(`type = $${paramIdx}`);
      params.push(patch.type);
      paramIdx++;
    }

    params.push(id, this.userId);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // nosemgrep: sql-injection-template-literal -- setClauses from hardcoded column names
      await client.query(
        `UPDATE knowledge SET ${setClauses.join(", ")} WHERE id = $${paramIdx} AND user_scope = $${paramIdx + 1}`,
        params
      );
      await client.query(
        `INSERT INTO knowledge_history (entry_id, old_summary, new_summary, old_details, new_details, event, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id, row.summary, patch.summary ?? row.summary,
          row.details, patch.details ?? row.details, "update", Date.now(),
        ]
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    await this.pruneHistoryForEntry(id);
    return true;
  }

  async deleteEntry(id: string): Promise<boolean> {
    const { rows: existing } = await this.pool.query<PgKnowledgeRow>(
      "SELECT * FROM knowledge WHERE id = $1 AND user_scope = $2",
      [id, this.userId]
    );
    if (existing.length === 0) return false;

    const row = existing[0];

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO knowledge_history (entry_id, old_summary, new_summary, old_details, new_details, event, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, row.summary, null, row.details, null, "delete", Date.now()]
      );
      await client.query(
        "DELETE FROM knowledge WHERE id = $1 AND user_scope = $2",
        [id, this.userId]
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    await this.pruneHistoryForEntry(id);
    return true;
  }

  async removeEntry(id: string): Promise<void> {
    await this.deleteEntry(id);
  }

  async getHistory(entryId: string, limit: number = 20): Promise<KnowledgeHistoryRow[]> {
    const effectiveLimit = Math.min(Math.max(limit, 1), 100);
    const { rows } = await this.pool.query<{
      id: string; entry_id: string; old_summary: string | null;
      new_summary: string | null; old_details: string | null;
      new_details: string | null; event: string; created_at: string;
    }>(
      "SELECT * FROM knowledge_history WHERE entry_id = $1 ORDER BY id DESC LIMIT $2",
      [entryId, effectiveLimit]
    );
    return rows.map((r) => ({
      id: Number(r.id),
      entry_id: r.entry_id,
      old_summary: r.old_summary,
      new_summary: r.new_summary,
      old_details: r.old_details,
      new_details: r.new_details,
      event: r.event as "add" | "update" | "delete",
      created_at: Number(r.created_at),
    }));
  }

  /** Prune history rows for an entry to keep at most 100. */
  private async pruneHistoryForEntry(entryId: string): Promise<void> {
    const { rows } = await this.pool.query<{ count: string }>(
      "SELECT COUNT(*) as count FROM knowledge_history WHERE entry_id = $1",
      [entryId]
    );
    if (Number(rows[0].count) > 100) {
      await this.pool.query(
        `DELETE FROM knowledge_history
         WHERE entry_id = $1 AND id NOT IN (
           SELECT id FROM knowledge_history WHERE entry_id = $1 ORDER BY id DESC LIMIT 100
         )`,
        [entryId]
      );
    }
  }

  async mergeProcedure(entry: KnowledgeEntry): Promise<void> {
    const user = entry.user || this.userId;

    const { rows: existingRows } = await this.pool.query(
      "SELECT id FROM knowledge WHERE project = $1 AND type = $2 AND summary = $3 AND user_scope = $4 LIMIT 1",
      [entry.project, entry.type, entry.summary, user]
    );

    if (existingRows.length === 0) {
      // No existing entry -- insert fresh
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details, tags, related_files, occurrences, project_count, extracted_at, user_scope)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            entry.id, entry.type, entry.project, entry.sessionId, entry.timestamp,
            entry.summary, entry.details, JSON.stringify(entry.tags),
            JSON.stringify(entry.relatedFiles), entry.occurrences ?? null,
            entry.projectCount ?? null, entry.extractedAt ?? null, user,
          ]
        );
        await client.query(
          `INSERT INTO knowledge_history (entry_id, old_summary, new_summary, old_details, new_details, event, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [entry.id, null, entry.summary, null, entry.details, "add", Date.now()]
        );
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
      return;
    }

    // Fetch existing entry
    const { rows: fullRows } = await this.pool.query<PgKnowledgeRow>(
      "SELECT * FROM knowledge WHERE id = $1 AND user_scope = $2",
      [existingRows[0].id, user]
    );
    if (fullRows.length === 0) return;

    const existing = rowToEntry(fullRows[0]);

    const existingDetails = parseProcedureDetails(existing.details);
    const newDetails = parseProcedureDetails(entry.details);
    if (!newDetails) return;

    const baseSteps = existingDetails?.steps ?? [];
    const mergedSteps = mergeStringArrays(baseSteps, newDetails.steps).slice(0, 20);
    const mergedPrereqs = mergeStringArrays(
      existingDetails?.prerequisites ?? [],
      newDetails.prerequisites ?? []
    );
    const mergedWarnings = mergeStringArrays(
      existingDetails?.warnings ?? [],
      newDetails.warnings ?? []
    );

    const mergedDetailsObj: ProcedureDetails = { steps: mergedSteps };
    if (mergedPrereqs.length > 0) mergedDetailsObj.prerequisites = mergedPrereqs;
    if (mergedWarnings.length > 0) mergedDetailsObj.warnings = mergedWarnings;

    const merged: KnowledgeEntry = {
      ...existing,
      details: JSON.stringify(mergedDetailsObj),
      occurrences: (existing.occurrences ?? 1) + 1,
      tags: [...new Set([...existing.tags, ...entry.tags])],
    };

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details, tags, related_files, occurrences, project_count, extracted_at, user_scope)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO UPDATE SET
           type = $2, project = $3, session_id = $4, timestamp = $5,
           summary = $6, details = $7, tags = $8, related_files = $9,
           occurrences = $10, project_count = $11, extracted_at = $12, user_scope = $13`,
        [
          merged.id, merged.type, merged.project, merged.sessionId, merged.timestamp,
          merged.summary, merged.details, JSON.stringify(merged.tags),
          JSON.stringify(merged.relatedFiles), merged.occurrences ?? null,
          merged.projectCount ?? null, merged.extractedAt ?? null, merged.user || this.userId,
        ]
      );
      await client.query(
        `INSERT INTO knowledge_history (entry_id, old_summary, new_summary, old_details, new_details, event, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          existing.id, existing.summary, merged.summary,
          existing.details, merged.details, "update", Date.now(),
        ]
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async getEntryCount(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      "SELECT COUNT(*) as count FROM knowledge WHERE user_scope = $1",
      [this.userId]
    );
    return Number(rows[0].count);
  }

  async getAllEntries(user?: string): Promise<KnowledgeEntry[]> {
    const effectiveUser = user ?? this.userId;
    const { rows } = await this.pool.query<PgKnowledgeRow>(
      "SELECT * FROM knowledge WHERE user_scope = $1 ORDER BY timestamp DESC",
      [effectiveUser]
    );
    return rows.map(rowToEntry);
  }

  async getEntries(options: KnowledgeListOptions): Promise<{ entries: KnowledgeEntry[]; total: number }> {
    const conditions: string[] = ["user_scope = $1"];
    const params: unknown[] = [this.userId];
    let paramIdx = 2;

    if (options.type) {
      conditions.push(`type = $${paramIdx}`);
      params.push(options.type);
      paramIdx++;
    }

    if (options.project) {
      conditions.push(`LOWER(project) LIKE '%' || LOWER($${paramIdx}) || '%'`);
      params.push(options.project);
      paramIdx++;
    }

    if (options.search) {
      conditions.push(
        `LOWER(summary || ' ' || details || ' ' || COALESCE(tags, '')) LIKE '%' || LOWER($${paramIdx}) || '%'`
      );
      params.push(options.search);
      paramIdx++;
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

    const countParams = [...params];
    // nosemgrep: sql-injection-template-literal -- where from code-controlled conditions
    const { rows: countRows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM knowledge ${where}`,
      countParams
    );

    params.push(options.limit, options.offset);
    // nosemgrep: sql-injection-template-literal -- where/orderBy from code-controlled conditions
    const { rows } = await this.pool.query<PgKnowledgeRow>(
      `SELECT * FROM knowledge ${where} ${orderBy} LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      params
    );

    return { entries: rows.map(rowToEntry), total: Number(countRows[0].count) };
  }

  async getTypeDistribution(project?: string): Promise<Record<string, number>> {
    let sql: string;
    let params: unknown[];

    if (project) {
      sql = "SELECT type, COUNT(*) as count FROM knowledge WHERE user_scope = $1 AND project = $2 GROUP BY type";
      params = [this.userId, project];
    } else {
      sql = "SELECT type, COUNT(*) as count FROM knowledge WHERE user_scope = $1 GROUP BY type";
      params = [this.userId];
    }

    const { rows } = await this.pool.query<{ type: string; count: string }>(sql, params);

    const out: Record<string, number> = {};
    for (const row of rows) {
      out[row.type] = Number(row.count);
    }
    return out;
  }

  /**
   * No-op: Pg store handles embeddings via pgvector triggers, not fire-and-forget promises.
   */
  async flushPendingEmbeddings(): Promise<number> {
    return 0;
  }
}
