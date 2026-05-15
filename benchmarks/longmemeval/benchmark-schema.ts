/**
 * Benchmark-only database schema extensions.
 *
 * Adds the `events` table and `events_fts` FTS5 virtual table for
 * SVO event indexing. These are benchmark-specific and do NOT go into
 * the production `src/storage/database.ts`.
 *
 * Call `initBenchmarkSchema(db)` after `openDatabase(":memory:")` in ingest.ts.
 */

import type Database from "better-sqlite3";
import type { SVOEvent } from "./extract-events.js";

/**
 * Create the events + events_fts tables in an existing database.
 * Safe to call multiple times — checks for table existence.
 */
export function initBenchmarkSchema(db: Database.Database): void {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='events'"
  ).get();

  if (!exists) {
    db.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject TEXT NOT NULL,
        verb TEXT NOT NULL,
        object TEXT NOT NULL,
        start_date TEXT,
        end_date TEXT,
        aliases TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'personal',
        session_index INTEGER NOT NULL,
        session_id TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE events_fts USING fts5(
        subject,
        verb,
        object,
        aliases,
        content=events,
        content_rowid=id,
        tokenize='porter unicode61'
      );

      -- Triggers to keep events_fts in sync
      CREATE TRIGGER events_ai AFTER INSERT ON events BEGIN
        INSERT INTO events_fts(rowid, subject, verb, object, aliases)
          VALUES (new.id, new.subject, new.verb, new.object, new.aliases);
      END;

      CREATE TRIGGER events_ad AFTER DELETE ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, subject, verb, object, aliases)
          VALUES ('delete', old.id, old.subject, old.verb, old.object, old.aliases);
      END;
    `);
  } else {
    // Production openDatabase() may have created the events table without
    // the benchmark-specific session_index column. Add it if missing.
    const cols = db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
    const hasSessionIndex = cols.some((c) => c.name === "session_index");
    if (!hasSessionIndex) {
      db.exec("ALTER TABLE events ADD COLUMN session_index INTEGER NOT NULL DEFAULT 0");
    }
    // Ensure events_fts exists (production schema may not have it)
    const ftsExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='events_fts'"
    ).get();
    if (!ftsExists) {
      db.exec(`
        CREATE VIRTUAL TABLE events_fts USING fts5(
          subject, verb, object, aliases,
          content=events, content_rowid=id,
          tokenize='porter unicode61'
        );
        CREATE TRIGGER events_ai AFTER INSERT ON events BEGIN
          INSERT INTO events_fts(rowid, subject, verb, object, aliases)
            VALUES (new.id, new.subject, new.verb, new.object, new.aliases);
        END;
        CREATE TRIGGER events_ad AFTER DELETE ON events BEGIN
          INSERT INTO events_fts(events_fts, rowid, subject, verb, object, aliases)
            VALUES ('delete', old.id, old.subject, old.verb, old.object, old.aliases);
        END;
      `);
    }
  }
}

/**
 * Bulk-insert SVO events into the events table.
 * FTS5 triggers handle indexing automatically.
 */
export function insertSVOEvents(db: Database.Database, events: SVOEvent[]): number {
  const stmt = db.prepare(`
    INSERT INTO events (subject, verb, object, start_date, end_date, aliases, category, session_index, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((evts: SVOEvent[]) => {
    let count = 0;
    for (const e of evts) {
      // Pipe-separate aliases so FTS5 tokenizes all alias words
      const aliasStr = e.aliases.join(" | ");
      stmt.run(e.subject, e.verb, e.object, e.startDate, e.endDate, aliasStr, e.category, e.sessionIndex, e.sessionId);
      count++;
    }
    return count;
  });

  return insertMany(events);
}

/**
 * Search events via FTS5. Returns matching events ranked by FTS5 relevance.
 * Searches across subject, verb, object, AND aliases — aliases bridge vocabulary gaps.
 */
export function searchEventsFts(
  db: Database.Database,
  query: string,
  limit: number = 30
): SVOEvent[] {
  // Sanitize query for FTS5 — remove special characters, try OR between words
  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);

  if (words.length === 0) return [];

  // Try AND first, fall back to OR if no results
  const andQuery = words.join(" AND ");
  const orQuery = words.join(" OR ");

  let rows = queryEventsFts(db, andQuery, limit);
  if (rows.length === 0) {
    rows = queryEventsFts(db, orQuery, limit);
  }

  return rows;
}

function queryEventsFts(
  db: Database.Database,
  ftsQuery: string,
  limit: number
): SVOEvent[] {
  try {
    const rows = db.prepare(`
      SELECT e.subject, e.verb, e.object, e.start_date, e.end_date,
             e.aliases, e.category, e.session_index, e.session_id
      FROM events e
      JOIN events_fts fts ON e.id = fts.rowid
      WHERE events_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, limit) as Array<{
      subject: string; verb: string; object: string;
      start_date: string | null; end_date: string | null;
      aliases: string; category: string;
      session_index: number; session_id: string;
    }>;

    return rows.map((r) => ({
      subject: r.subject,
      verb: r.verb,
      object: r.object,
      startDate: r.start_date,
      endDate: r.end_date,
      aliases: r.aliases ? r.aliases.split(" | ").filter(Boolean) : [],
      category: r.category,
      sessionIndex: r.session_index,
      sessionId: r.session_id,
    }));
  } catch {
    return [];
  }
}
