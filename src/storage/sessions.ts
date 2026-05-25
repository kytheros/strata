import type Database from "better-sqlite3";

export interface CanonicalSession {
  sessionId: string;
  startTime: number;
  endTime: number;
  project: string;
  messageCount: number;
  knowledgeCount: number;
  eventCount: number;
  hasSummary: boolean;
  topic?: string;
  toolsUsed?: string[];
}

export interface ListSessionsFilters {
  project?: string;
  sinceMs?: number;
  limit?: number;
  offset?: number;
}

export function listCanonicalSessions(
  db: Database.Database,
  filters: ListSessionsFilters
): { rows: CanonicalSession[]; total: number } {
  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;
  const sinceClause = filters.sinceMs ? `AND ts >= ${Number(filters.sinceMs)}` : "";

  // Step 1: collect distinct (session_id, project, min_ts, max_ts) across all 4 sources
  // Each source emits rows shaped (sid, project, ts) so we aggregate uniformly.
  const sql = `
    WITH all_session_rows AS (
      SELECT session_id AS sid, project, timestamp AS ts FROM knowledge WHERE session_id IS NOT NULL AND session_id != ''
      UNION ALL
      SELECT session_id AS sid, project, timestamp AS ts FROM documents WHERE session_id IS NOT NULL AND session_id != ''
      UNION ALL
      SELECT session_id AS sid, project, timestamp AS ts FROM events WHERE session_id IS NOT NULL AND session_id != ''
      UNION ALL
      SELECT session_id AS sid, project, start_time AS ts FROM summaries WHERE session_id IS NOT NULL AND session_id != ''
    ),
    distinct_sessions AS (
      SELECT sid, MAX(project) AS project, MIN(ts) AS start_time, MAX(ts) AS end_time
      FROM all_session_rows
      WHERE 1=1 ${sinceClause}
      GROUP BY sid
    )
    SELECT
      ds.sid AS session_id,
      ds.project,
      ds.start_time,
      ds.end_time,
      (SELECT COUNT(*) FROM documents WHERE session_id = ds.sid) AS message_count,
      (SELECT COUNT(*) FROM knowledge WHERE session_id = ds.sid) AS knowledge_count,
      (SELECT COUNT(*) FROM events    WHERE session_id = ds.sid) AS event_count,
      (SELECT topic       FROM summaries WHERE session_id = ds.sid LIMIT 1) AS topic,
      (SELECT tools_used  FROM summaries WHERE session_id = ds.sid LIMIT 1) AS tools_used
    FROM distinct_sessions ds
    ORDER BY ds.start_time DESC
    LIMIT ? OFFSET ?
  `;

  // Project filter is applied post-query against the canonicalized value because
  // the source columns hold raw slugs. Callers should pass an already-canonical
  // slug; we match against ALL the project strings (one canonical may have
  // multiple aliases). Caller's responsibility to expand if needed; this helper
  // matches the canonical slug literally for simplicity.
  let allRows = db.prepare(sql).all(limit, offset) as Array<{
    session_id: string; project: string; start_time: number; end_time: number;
    message_count: number; knowledge_count: number; event_count: number;
    topic: string | null; tools_used: string | null;
  }>;

  if (filters.project) {
    // Match by raw or canonical project string.
    const want = filters.project;
    allRows = allRows.filter(r => r.project === want);
  }

  // Total count (same filters, no limit)
  const totalSql = `
    WITH all_session_rows AS (
      SELECT session_id AS sid, project, timestamp AS ts FROM knowledge WHERE session_id IS NOT NULL AND session_id != ''
      UNION ALL
      SELECT session_id AS sid, project, timestamp AS ts FROM documents WHERE session_id IS NOT NULL AND session_id != ''
      UNION ALL
      SELECT session_id AS sid, project, timestamp AS ts FROM events WHERE session_id IS NOT NULL AND session_id != ''
      UNION ALL
      SELECT session_id AS sid, project, start_time AS ts FROM summaries WHERE session_id IS NOT NULL AND session_id != ''
    )
    SELECT COUNT(DISTINCT sid) AS c FROM all_session_rows WHERE 1=1 ${sinceClause}
  `;
  const totalRow = db.prepare(totalSql).get() as { c: number };
  let total = totalRow.c;
  if (filters.project) total = allRows.length;  // filter is post-query

  const rows: CanonicalSession[] = allRows.map(r => ({
    sessionId: r.session_id,
    startTime: r.start_time,
    endTime: r.end_time,
    project: r.project ?? "unknown",
    messageCount: r.message_count,
    knowledgeCount: r.knowledge_count,
    eventCount: r.event_count,
    hasSummary: r.topic != null,
    topic: r.topic ?? undefined,
    toolsUsed: r.tools_used ? safeJsonArray(r.tools_used) : undefined,
  }));

  return { rows, total };
}

function safeJsonArray(s: string): string[] {
  try {
    const arr = JSON.parse(s);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch { return []; }
}
