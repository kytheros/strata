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

  // Fix 1: treat sinceMs=0 as genuine epoch anchor (0 is a valid timestamp).
  // The old `filters.sinceMs ?` check was falsy for 0, silently dropping the filter.
  const sinceClause = filters.sinceMs != null && isFinite(filters.sinceMs) && filters.sinceMs > 0
    ? `AND ts >= ${filters.sinceMs}`
    : "";

  // Fix 3: expand canonical project slug → all raw aliases so the SQL filter
  // matches every raw project string that maps to the same canonical slug.
  // Falls back to [filters.project] when no projects row exists (e.g., in tests
  // that seed raw strings without going through canonicalProject()).
  let projectAliases: string[] | null = null;
  if (filters.project) {
    const row = db.prepare(
      "SELECT aliases FROM projects WHERE canonical_slug = ?"
    ).get(filters.project) as { aliases: string } | undefined;
    projectAliases = row ? JSON.parse(row.aliases) as string[] : [filters.project];
    // Always include the canonical slug itself in case it's stored raw.
    if (!projectAliases.includes(filters.project)) projectAliases.push(filters.project);
  }

  const projectClause = projectAliases
    ? `AND project IN (${projectAliases.map(() => "?").join(",")})`
    : "";

  // Step 1: collect distinct (session_id, project, min_ts, max_ts) across all 4 sources
  // Each source emits rows shaped (sid, project, ts) so we aggregate uniformly.
  const sql = `
    WITH all_session_rows AS (
      SELECT session_id AS sid, project, timestamp AS ts FROM knowledge WHERE session_id IS NOT NULL AND session_id != '' ${sinceClause} ${projectClause}
      UNION ALL
      SELECT session_id AS sid, project, timestamp AS ts FROM documents WHERE session_id IS NOT NULL AND session_id != '' ${sinceClause} ${projectClause}
      UNION ALL
      SELECT session_id AS sid, project, timestamp AS ts FROM events WHERE session_id IS NOT NULL AND session_id != '' ${sinceClause} ${projectClause}
      UNION ALL
      SELECT session_id AS sid, project, start_time AS ts FROM summaries WHERE session_id IS NOT NULL AND session_id != '' ${sinceClause} ${projectClause}
    ),
    distinct_sessions AS (
      SELECT sid, MAX(project) AS project, MIN(ts) AS start_time, MAX(ts) AS end_time
      FROM all_session_rows
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

  // Build the bound params: for each of the 4 UNION branches, supply projectAliases (if set).
  const unionParams: unknown[] = projectAliases
    ? [
        ...projectAliases, // knowledge branch
        ...projectAliases, // documents branch
        ...projectAliases, // events branch
        ...projectAliases, // summaries branch
      ]
    : [];

  const allRows = db.prepare(sql).all(...unionParams, limit, offset) as Array<{
    session_id: string; project: string; start_time: number; end_time: number;
    message_count: number; knowledge_count: number; event_count: number;
    topic: string | null; tools_used: string | null;
  }>;

  // Total count (same filters, no limit)
  const totalSql = `
    WITH all_session_rows AS (
      SELECT session_id AS sid, project, timestamp AS ts FROM knowledge WHERE session_id IS NOT NULL AND session_id != '' ${sinceClause} ${projectClause}
      UNION ALL
      SELECT session_id AS sid, project, timestamp AS ts FROM documents WHERE session_id IS NOT NULL AND session_id != '' ${sinceClause} ${projectClause}
      UNION ALL
      SELECT session_id AS sid, project, timestamp AS ts FROM events WHERE session_id IS NOT NULL AND session_id != '' ${sinceClause} ${projectClause}
      UNION ALL
      SELECT session_id AS sid, project, start_time AS ts FROM summaries WHERE session_id IS NOT NULL AND session_id != '' ${sinceClause} ${projectClause}
    )
    SELECT COUNT(DISTINCT sid) AS c FROM all_session_rows
  `;
  const totalRow = db.prepare(totalSql).get(...unionParams) as { c: number };
  const total = totalRow.c;

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
