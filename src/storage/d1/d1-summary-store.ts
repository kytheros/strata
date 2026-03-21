/**
 * D1-backed session summary store.
 *
 * Implements ISummaryStore using Cloudflare D1 async APIs.
 * Mirrors SqliteSummaryStore method-for-method, including JSON data column
 * handling, heatmap aggregation, and json_extract() for filtering.
 */

import type { D1Database } from "./d1-types.js";
import type { SessionSummary } from "../../knowledge/session-summarizer.js";
import type { ISummaryStore, SessionListOptions } from "../interfaces/index.js";

/** Row shape returned from D1 queries against the summaries table. */
interface D1SummaryRow {
  session_id: string;
  project: string;
  tool: string;
  topic: string;
  start_time: number;
  end_time: number;
  message_count: number;
  tools_used: string | null;
  data: string;
  user: string;
}

function rowToSummary(row: D1SummaryRow): SessionSummary {
  return JSON.parse(row.data) as SessionSummary;
}

export class D1SummaryStore implements ISummaryStore {
  constructor(
    private db: D1Database,
    private userId: string,
  ) {}

  async save(summary: SessionSummary, tool: string = "claude-code"): Promise<void> {
    await this.db
      .prepare(`
        INSERT OR REPLACE INTO summaries (session_id, project, tool, topic, start_time, end_time, message_count, tools_used, data, user)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        summary.sessionId,
        summary.project,
        tool,
        summary.topic,
        summary.startTime,
        summary.endTime,
        summary.messageCount,
        JSON.stringify(summary.toolsUsed),
        JSON.stringify(summary),
        this.userId
      )
      .run();
  }

  async get(sessionId: string): Promise<SessionSummary | null> {
    const row = await this.db
      .prepare("SELECT * FROM summaries WHERE session_id = ? AND user = ?")
      .bind(sessionId, this.userId)
      .first<D1SummaryRow>();
    return row ? rowToSummary(row) : null;
  }

  async getByProject(project: string): Promise<SessionSummary[]> {
    const result = await this.db
      .prepare(
        "SELECT * FROM summaries WHERE LOWER(project) LIKE '%' || LOWER(?) || '%' AND user = ? ORDER BY end_time DESC"
      )
      .bind(project, this.userId)
      .all<D1SummaryRow>();
    return result.results.map(rowToSummary);
  }

  async getByTool(tool: string): Promise<SessionSummary[]> {
    const result = await this.db
      .prepare("SELECT * FROM summaries WHERE tool = ? AND user = ? ORDER BY end_time DESC")
      .bind(tool, this.userId)
      .all<D1SummaryRow>();
    return result.results.map(rowToSummary);
  }

  async getRecent(limit: number = 10): Promise<SessionSummary[]> {
    const result = await this.db
      .prepare("SELECT * FROM summaries WHERE user = ? ORDER BY end_time DESC LIMIT ?")
      .bind(this.userId, limit)
      .all<D1SummaryRow>();
    return result.results.map(rowToSummary);
  }

  async getAll(): Promise<SessionSummary[]> {
    const result = await this.db
      .prepare("SELECT * FROM summaries WHERE user = ? ORDER BY end_time DESC")
      .bind(this.userId)
      .all<D1SummaryRow>();
    return result.results.map(rowToSummary);
  }

  async remove(sessionId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM summaries WHERE session_id = ? AND user = ?")
      .bind(sessionId, this.userId)
      .run();
  }

  async getCount(): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) as count FROM summaries WHERE user = ?")
      .bind(this.userId)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  async getSessions(options: SessionListOptions): Promise<{ sessions: SessionSummary[]; total: number }> {
    const conditions: string[] = ["user = ?"];
    const params: unknown[] = [this.userId];

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

    const where = `WHERE ${conditions.join(" AND ")}`;

    // nosemgrep: semgrep.sql-injection-template-literal — where built from code-controlled conditions, user values bound via .bind()
    const countRow = await this.db
      .prepare(`SELECT COUNT(*) as count FROM summaries ${where}`)
      .bind(...params)
      .first<{ count: number }>();

    // nosemgrep: semgrep.sql-injection-template-literal — where built from code-controlled conditions, user values bound via .bind()
    const result = await this.db
      .prepare(`SELECT * FROM summaries ${where} ORDER BY end_time DESC LIMIT ? OFFSET ?`)
      .bind(...params, options.limit, options.offset)
      .all<D1SummaryRow>();

    return { sessions: result.results.map(rowToSummary), total: countRow?.count ?? 0 };
  }

  async getSessionHeatmap(sinceMs: number): Promise<Array<{ date: string; count: number }>> {
    const result = await this.db
      .prepare(
        `SELECT DATE(end_time / 1000, 'unixepoch') as date, COUNT(*) as count
         FROM summaries
         WHERE end_time >= ? AND user = ?
         GROUP BY date
         ORDER BY date`
      )
      .bind(sinceMs, this.userId)
      .all<{ date: string; count: number }>();
    return result.results;
  }

  async getProjectSessionCounts(): Promise<Record<string, number>> {
    const result = await this.db
      .prepare("SELECT project, COUNT(*) as count FROM summaries WHERE user = ? GROUP BY project")
      .bind(this.userId)
      .all<{ project: string; count: number }>();

    const out: Record<string, number> = {};
    for (const row of result.results) {
      out[row.project] = row.count;
    }
    return out;
  }
}
