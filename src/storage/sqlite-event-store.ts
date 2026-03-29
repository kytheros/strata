/**
 * SQLite-backed event store for SVO (Subject-Verb-Object) event extraction.
 *
 * Stores structured events extracted from conversation sessions and provides
 * FTS5-powered search across subjects, verbs, objects, and lexical aliases.
 * Events bridge vocabulary gaps — a search for "fitness tracker" finds events
 * where the user "bought Fitbit" via alias indexing.
 */

import type Database from "better-sqlite3";
import type { IEventStore, SVOEvent } from "./interfaces/event-store.js";

export class SqliteEventStore implements IEventStore {
  constructor(private db: Database.Database) {}

  async addEvents(events: SVOEvent[], user?: string): Promise<number> {
    if (!this.tableExists()) return 0;

    const stmt = this.db.prepare(`
      INSERT INTO events (subject, verb, object, start_date, end_date, aliases, category, session_id, project, timestamp, user)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((evts: SVOEvent[]) => {
      let count = 0;
      for (const e of evts) {
        const aliasStr = e.aliases.join(" | ");
        stmt.run(
          e.subject,
          e.verb,
          e.object,
          e.startDate,
          e.endDate,
          aliasStr,
          e.category,
          e.sessionId,
          e.project,
          e.timestamp,
          user ?? null
        );
        count++;
      }
      return count;
    });

    return insertMany(events);
  }

  async search(query: string, limit = 30): Promise<SVOEvent[]> {
    if (!this.tableExists()) return [];

    // Sanitize query into individual words for FTS5
    const words = query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1);
    if (words.length === 0) return [];

    const andQuery = words.join(" AND ");
    const orQuery = words.join(" OR ");

    // Try AND first for precision, fall back to OR for recall
    let rows = this.queryFts(andQuery, limit);
    if (rows.length === 0) {
      rows = this.queryFts(orQuery, limit);
    }
    return rows;
  }

  private queryFts(ftsQuery: string, limit: number): SVOEvent[] {
    try {
      const rows = this.db
        .prepare(
          `
        SELECT e.subject, e.verb, e.object, e.start_date, e.end_date,
               e.aliases, e.category, e.session_id, e.project, e.timestamp
        FROM events e
        JOIN events_fts fts ON e.id = fts.rowid
        WHERE events_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `
        )
        .all(ftsQuery, limit) as Array<{
        subject: string;
        verb: string;
        object: string;
        start_date: string | null;
        end_date: string | null;
        aliases: string;
        category: string;
        session_id: string;
        project: string;
        timestamp: number;
      }>;

      return rows.map((r) => ({
        subject: r.subject,
        verb: r.verb,
        object: r.object,
        startDate: r.start_date,
        endDate: r.end_date,
        aliases: r.aliases ? r.aliases.split(" | ").filter(Boolean) : [],
        category: r.category,
        sessionId: r.session_id,
        project: r.project,
        timestamp: r.timestamp,
      }));
    } catch {
      return [];
    }
  }

  async getBySession(sessionId: string): Promise<SVOEvent[]> {
    if (!this.tableExists()) return [];

    const rows = this.db
      .prepare("SELECT * FROM events WHERE session_id = ? ORDER BY id")
      .all(sessionId) as Array<{
      subject: string;
      verb: string;
      object: string;
      start_date: string | null;
      end_date: string | null;
      aliases: string;
      category: string;
      session_id: string;
      project: string;
      timestamp: number;
    }>;

    return rows.map((r) => ({
      subject: r.subject,
      verb: r.verb,
      object: r.object,
      startDate: r.start_date,
      endDate: r.end_date,
      aliases: r.aliases ? r.aliases.split(" | ").filter(Boolean) : [],
      category: r.category,
      sessionId: r.session_id,
      project: r.project,
      timestamp: r.timestamp,
    }));
  }

  async deleteBySession(sessionId: string): Promise<void> {
    if (!this.tableExists()) return;
    this.db.prepare("DELETE FROM events WHERE session_id = ?").run(sessionId);
  }

  async getEventCount(): Promise<number> {
    if (!this.tableExists()) return 0;
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM events")
      .get() as { count: number };
    return row.count;
  }

  /** Check if events table exists (handles old databases without the table). */
  private tableExists(): boolean {
    const exists = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='events'"
      )
      .get();
    return !!exists;
  }
}
