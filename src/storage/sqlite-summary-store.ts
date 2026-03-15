/**
 * SQLite-backed session summary store.
 * Replaces the per-file JSON summaries in summaries/*.json.
 */

import type Database from "better-sqlite3";
import type { SessionSummary } from "../knowledge/session-summarizer.js";

export class SqliteSummaryStore {
  private stmts: {
    upsert: Database.Statement;
    getById: Database.Statement;
    getByProject: Database.Statement;
    getAll: Database.Statement;
    remove: Database.Statement;
    count: Database.Statement;
    getRecent: Database.Statement;
    getByTool: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      upsert: db.prepare(`
        INSERT OR REPLACE INTO summaries (session_id, project, tool, topic, start_time, end_time, message_count, tools_used, data)
        VALUES (@sessionId, @project, @tool, @topic, @startTime, @endTime, @messageCount, @toolsUsed, @data)
      `),
      getById: db.prepare("SELECT * FROM summaries WHERE session_id = ?"),
      getByProject: db.prepare("SELECT * FROM summaries WHERE LOWER(project) LIKE '%' || LOWER(?) || '%' ORDER BY end_time DESC"),
      getAll: db.prepare("SELECT * FROM summaries ORDER BY end_time DESC"),
      remove: db.prepare("DELETE FROM summaries WHERE session_id = ?"),
      count: db.prepare("SELECT COUNT(*) as count FROM summaries"),
      getRecent: db.prepare("SELECT * FROM summaries ORDER BY end_time DESC LIMIT ?"),
      getByTool: db.prepare("SELECT * FROM summaries WHERE tool = ? ORDER BY end_time DESC"),
    };
  }

  /**
   * Save (upsert) a session summary.
   */
  save(summary: SessionSummary, tool: string = "claude-code"): void {
    this.stmts.upsert.run({
      sessionId: summary.sessionId,
      project: summary.project,
      tool,
      topic: summary.topic,
      startTime: summary.startTime,
      endTime: summary.endTime,
      messageCount: summary.messageCount,
      toolsUsed: JSON.stringify(summary.toolsUsed),
      data: JSON.stringify(summary),
    });
  }

  /**
   * Get a summary by session ID.
   */
  get(sessionId: string): SessionSummary | null {
    const row = this.stmts.getById.get(sessionId) as SqliteSummaryRow | undefined;
    return row ? rowToSummary(row) : null;
  }

  /**
   * Get summaries for a project (partial match).
   */
  getByProject(project: string): SessionSummary[] {
    const rows = this.stmts.getByProject.all(project) as SqliteSummaryRow[];
    return rows.map(rowToSummary);
  }

  /**
   * Get summaries by tool type.
   */
  getByTool(tool: string): SessionSummary[] {
    const rows = this.stmts.getByTool.all(tool) as SqliteSummaryRow[];
    return rows.map(rowToSummary);
  }

  /**
   * Get the N most recent summaries.
   */
  getRecent(limit: number = 10): SessionSummary[] {
    const rows = this.stmts.getRecent.all(limit) as SqliteSummaryRow[];
    return rows.map(rowToSummary);
  }

  /**
   * Get all summaries.
   */
  getAll(): SessionSummary[] {
    const rows = this.stmts.getAll.all() as SqliteSummaryRow[];
    return rows.map(rowToSummary);
  }

  /**
   * Remove a summary by session ID.
   */
  remove(sessionId: string): void {
    this.stmts.remove.run(sessionId);
  }

  /**
   * Get total summary count.
   */
  getCount(): number {
    const row = this.stmts.count.get() as { count: number };
    return row.count;
  }

  /**
   * Paginated session listing with filters.
   */
  getSessions(options: {
    project?: string;
    tool?: string;
    hasCodeChanges?: boolean;
    limit: number;
    offset: number;
  }): { sessions: SessionSummary[]; total: number } {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.project) {
      conditions.push("LOWER(project) LIKE '%' || LOWER(?) || '%'");
      params.push(options.project);
    }

    if (options.tool) {
      conditions.push("tool = ?");
      params.push(options.tool);
    }

    if (options.hasCodeChanges !== undefined) {
      conditions.push(
        `json_extract(data, '$.hasCodeChanges') = ${options.hasCodeChanges ? 1 : 0}`
      );
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM summaries ${where}`)
      .get(...params) as { count: number };

    const rows = this.db
      .prepare(`SELECT * FROM summaries ${where} ORDER BY end_time DESC LIMIT ? OFFSET ?`)
      .all(...params, options.limit, options.offset) as SqliteSummaryRow[];

    return { sessions: rows.map(rowToSummary), total: countRow.count };
  }

  /**
   * Calendar heatmap data: session count per day.
   */
  getSessionHeatmap(sinceMs: number): Array<{ date: string; count: number }> {
    return this.db
      .prepare(
        `SELECT DATE(end_time / 1000, 'unixepoch') as date, COUNT(*) as count
         FROM summaries
         WHERE end_time >= ?
         GROUP BY date
         ORDER BY date`
      )
      .all(sinceMs) as Array<{ date: string; count: number }>;
  }

  /**
   * Per-project session counts.
   */
  getProjectSessionCounts(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT project, COUNT(*) as count FROM summaries GROUP BY project")
      .all() as Array<{ project: string; count: number }>;

    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.project] = row.count;
    }
    return result;
  }
}

// --- Internal helpers ---

interface SqliteSummaryRow {
  session_id: string;
  project: string;
  tool: string;
  topic: string;
  start_time: number;
  end_time: number;
  message_count: number;
  tools_used: string | null;
  data: string;
}

function rowToSummary(row: SqliteSummaryRow): SessionSummary {
  return JSON.parse(row.data) as SessionSummary;
}
