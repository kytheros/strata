/**
 * Postgres-backed SVO event store.
 *
 * Implements IEventStore using pg Pool async APIs.
 * Uses weighted tsvector (subject=A, verb=B, object=C, aliases=D) with ts_rank.
 */

import type { PgPool } from "./pg-types.js";
import type { IEventStore, SVOEvent } from "../interfaces/index.js";

/** Row shape returned from Postgres queries against the events table. */
interface PgEventRow {
  id: string;
  subject: string;
  verb: string;
  object: string;
  start_date: string | null;
  end_date: string | null;
  aliases: string;
  category: string;
  session_id: string;
  project: string;
  timestamp: string; // bigint comes as string
  user_scope: string | null;
}

function rowToEvent(row: PgEventRow): SVOEvent {
  return {
    subject: row.subject,
    verb: row.verb,
    object: row.object,
    startDate: row.start_date,
    endDate: row.end_date,
    aliases: row.aliases ? row.aliases.split(",").map((a) => a.trim()).filter(Boolean) : [],
    category: row.category,
    sessionId: row.session_id,
    project: row.project,
    timestamp: Number(row.timestamp),
  };
}

export class PgEventStore implements IEventStore {
  constructor(
    private pool: PgPool,
    private userId: string,
  ) {}

  /**
   * Insert multiple SVO events in a single transaction.
   * Returns the number of events inserted.
   */
  async addEvents(events: SVOEvent[], user?: string): Promise<number> {
    if (events.length === 0) return 0;

    const effectiveUser = user ?? this.userId;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      for (const event of events) {
        await client.query(
          `INSERT INTO events (subject, verb, object, start_date, end_date, aliases, category, session_id, project, timestamp, user_scope)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            event.subject,
            event.verb,
            event.object,
            event.startDate ?? null,
            event.endDate ?? null,
            event.aliases.join(", "),
            event.category,
            event.sessionId,
            event.project,
            event.timestamp,
            effectiveUser,
          ]
        );
      }

      await client.query("COMMIT");
      return events.length;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Full-text search over events using weighted tsvector.
   * Returns events ranked by ts_rank (positive, higher = better).
   */
  async search(query: string, limit: number = 20): Promise<SVOEvent[]> {
    if (!query.trim()) return [];

    const { rows } = await this.pool.query<PgEventRow & { rank: number }>(
      `SELECT e.*, ts_rank(e.tsv, plainto_tsquery('english', $1)) AS rank
       FROM events e
       WHERE e.tsv @@ plainto_tsquery('english', $1)
       ORDER BY rank DESC
       LIMIT $2`,
      [query, limit]
    );

    return rows.map(rowToEvent);
  }

  async getBySession(sessionId: string): Promise<SVOEvent[]> {
    const { rows } = await this.pool.query<PgEventRow>(
      "SELECT * FROM events WHERE session_id = $1 ORDER BY timestamp",
      [sessionId]
    );
    return rows.map(rowToEvent);
  }

  async deleteBySession(sessionId: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM events WHERE session_id = $1",
      [sessionId]
    );
  }

  async getEventCount(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      "SELECT COUNT(*) as count FROM events"
    );
    return Number(rows[0].count);
  }
}
