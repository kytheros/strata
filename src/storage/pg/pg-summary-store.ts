/**
 * Postgres-backed session summary store.
 *
 * Implements ISummaryStore using pg Pool async APIs.
 * No FTS -- direct port from D1 adapter with Postgres syntax.
 */

import type { PgPool } from "./pg-types.js";
import type { SessionSummary } from "../../knowledge/session-summarizer.js";
import type { ISummaryStore, SessionListOptions } from "../interfaces/index.js";

/** Row shape returned from Postgres queries against the summaries table. */
interface PgSummaryRow {
  session_id: string;
  project: string;
  tool: string;
  topic: string;
  start_time: string; // bigint
  end_time: string;   // bigint
  message_count: number;
  tools_used: string | null;
  data: string;
  user_scope: string;
}

function rowToSummary(row: PgSummaryRow): SessionSummary {
  return JSON.parse(row.data) as SessionSummary;
}

export class PgSummaryStore implements ISummaryStore {
  constructor(
    private pool: PgPool,
    private userId: string,
  ) {}

  async save(summary: SessionSummary, tool: string = "claude-code"): Promise<void> {
    await this.pool.query(
      `INSERT INTO summaries (session_id, project, tool, topic, start_time, end_time, message_count, tools_used, data, user_scope)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (session_id) DO UPDATE SET
         project = $2, tool = $3, topic = $4, start_time = $5, end_time = $6,
         message_count = $7, tools_used = $8, data = $9, user_scope = $10`,
      [
        summary.sessionId,
        summary.project,
        tool,
        summary.topic,
        summary.startTime,
        summary.endTime,
        summary.messageCount,
        JSON.stringify(summary.toolsUsed),
        JSON.stringify(summary),
        this.userId,
      ]
    );
  }

  async get(sessionId: string): Promise<SessionSummary | null> {
    const { rows } = await this.pool.query<PgSummaryRow>(
      "SELECT * FROM summaries WHERE session_id = $1 AND user_scope = $2",
      [sessionId, this.userId]
    );
    return rows.length > 0 ? rowToSummary(rows[0]) : null;
  }

  async getByProject(project: string): Promise<SessionSummary[]> {
    const { rows } = await this.pool.query<PgSummaryRow>(
      "SELECT * FROM summaries WHERE LOWER(project) LIKE '%' || LOWER($1) || '%' AND user_scope = $2 ORDER BY end_time DESC",
      [project, this.userId]
    );
    return rows.map(rowToSummary);
  }

  async getByTool(tool: string): Promise<SessionSummary[]> {
    const { rows } = await this.pool.query<PgSummaryRow>(
      "SELECT * FROM summaries WHERE tool = $1 AND user_scope = $2 ORDER BY end_time DESC",
      [tool, this.userId]
    );
    return rows.map(rowToSummary);
  }

  async getRecent(limit: number = 10): Promise<SessionSummary[]> {
    const { rows } = await this.pool.query<PgSummaryRow>(
      "SELECT * FROM summaries WHERE user_scope = $1 ORDER BY end_time DESC LIMIT $2",
      [this.userId, limit]
    );
    return rows.map(rowToSummary);
  }

  async getAll(): Promise<SessionSummary[]> {
    const { rows } = await this.pool.query<PgSummaryRow>(
      "SELECT * FROM summaries WHERE user_scope = $1 ORDER BY end_time DESC",
      [this.userId]
    );
    return rows.map(rowToSummary);
  }

  async remove(sessionId: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM summaries WHERE session_id = $1 AND user_scope = $2",
      [sessionId, this.userId]
    );
  }

  async getCount(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      "SELECT COUNT(*) as count FROM summaries WHERE user_scope = $1",
      [this.userId]
    );
    return Number(rows[0].count);
  }

  async getSessions(options: SessionListOptions): Promise<{ sessions: SessionSummary[]; total: number }> {
    const conditions: string[] = ["user_scope = $1"];
    const params: unknown[] = [this.userId];
    let paramIdx = 2;

    if (options.project) {
      conditions.push(`LOWER(project) LIKE '%' || LOWER($${paramIdx}) || '%'`);
      params.push(options.project);
      paramIdx++;
    }

    if (options.tool) {
      conditions.push(`tool = $${paramIdx}`);
      params.push(options.tool);
      paramIdx++;
    }

    if (options.hasCodeChanges !== undefined) {
      // Postgres json extraction: data::jsonb->>'hasCodeChanges'
      conditions.push(`(data::jsonb->>'hasCodeChanges')::boolean = $${paramIdx}`);
      params.push(options.hasCodeChanges);
      paramIdx++;
    }

    const where = `WHERE ${conditions.join(" AND ")}`;

    const countParams = [...params];
    // nosemgrep: sql-injection-template-literal -- where from code-controlled conditions
    const { rows: countRows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM summaries ${where}`,
      countParams
    );

    params.push(options.limit, options.offset);
    // nosemgrep: sql-injection-template-literal -- where from code-controlled conditions
    const { rows } = await this.pool.query<PgSummaryRow>(
      `SELECT * FROM summaries ${where} ORDER BY end_time DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      params
    );

    return { sessions: rows.map(rowToSummary), total: Number(countRows[0].count) };
  }

  async getSessionHeatmap(sinceMs: number): Promise<Array<{ date: string; count: number }>> {
    const { rows } = await this.pool.query<{ date: string; count: string }>(
      `SELECT to_char(to_timestamp(end_time / 1000), 'YYYY-MM-DD') as date, COUNT(*) as count
       FROM summaries
       WHERE end_time >= $1 AND user_scope = $2
       GROUP BY date
       ORDER BY date`,
      [sinceMs, this.userId]
    );
    return rows.map((r) => ({ date: r.date, count: Number(r.count) }));
  }

  async getProjectSessionCounts(): Promise<Record<string, number>> {
    const { rows } = await this.pool.query<{ project: string; count: string }>(
      "SELECT project, COUNT(*) as count FROM summaries WHERE user_scope = $1 GROUP BY project",
      [this.userId]
    );

    const out: Record<string, number> = {};
    for (const row of rows) {
      out[row.project] = Number(row.count);
    }
    return out;
  }
}
