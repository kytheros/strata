import type Database from "better-sqlite3";

const PATH_SLUG_RE = /^([A-Za-z])(--|:[\/\\])/;

export function normalizeProjectSlug(raw: string | null | undefined): string {
  if (!raw) return "unknown";
  let s = String(raw).trim();
  if (!s) return "unknown";
  if (PATH_SLUG_RE.test(s)) {
    s = s.replace(/^([A-Za-z])--/, "$1:/");
    s = s.replace(/\\/g, "/");
    // de-dupe trailing-segment (E:/strata/strata → E:/strata)
    const parts = s.split("/");
    if (parts.length >= 2 && parts[parts.length - 1] === parts[parts.length - 2]) {
      parts.pop();
      s = parts.join("/");
    }
    return s;
  }
  return s.toLowerCase();
}

export interface Project {
  canonical_slug: string;
  display_name: string;
  aliases: string[];
  first_seen: number;
  last_seen: number;
}

export function canonicalProject(rawSlug: string | null | undefined, db: Database.Database): string {
  const canonical = normalizeProjectSlug(rawSlug);
  const raw = rawSlug ?? "";
  const now = Date.now();
  const existing = db.prepare("SELECT aliases FROM projects WHERE canonical_slug = ?").get(canonical) as { aliases: string } | undefined;
  if (!existing) {
    db.prepare("INSERT INTO projects (canonical_slug, display_name, aliases, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)")
      .run(canonical, canonical, JSON.stringify(raw ? [raw] : []), now, now);
  } else {
    const aliases = JSON.parse(existing.aliases) as string[];
    if (raw && !aliases.includes(raw)) {
      aliases.push(raw);
      db.prepare("UPDATE projects SET aliases = ?, last_seen = ? WHERE canonical_slug = ?")
        .run(JSON.stringify(aliases), now, canonical);
    }
  }
  return canonical;
}

export function listProjects(db: Database.Database): Project[] {
  const rows = db.prepare("SELECT * FROM projects ORDER BY canonical_slug").all() as Array<{ canonical_slug: string; display_name: string; aliases: string; first_seen: number; last_seen: number }>;
  return rows.map(r => ({
    canonical_slug: r.canonical_slug,
    display_name: r.display_name,
    aliases: JSON.parse(r.aliases),
    first_seen: r.first_seen,
    last_seen: r.last_seen,
  }));
}

export function backfillProjects(db: Database.Database): void {
  // Collect (rawSlug, firstSeen, lastSeen) from each content table.
  const sources = [
    `SELECT project AS slug, MIN(timestamp) AS first_seen, MAX(timestamp) AS last_seen FROM knowledge WHERE project IS NOT NULL GROUP BY project`,
    `SELECT project AS slug, MIN(timestamp) AS first_seen, MAX(timestamp) AS last_seen FROM analytics WHERE project IS NOT NULL GROUP BY project`,
    `SELECT project AS slug, MIN(first_seen) AS first_seen, MAX(last_seen) AS last_seen FROM entities WHERE project IS NOT NULL GROUP BY project`,
    `SELECT project AS slug, MIN(occurred_at) AS first_seen, MAX(occurred_at) AS last_seen FROM evidence_gaps WHERE project IS NOT NULL GROUP BY project`,
    `SELECT project AS slug, MIN(timestamp) AS first_seen, MAX(timestamp) AS last_seen FROM events WHERE project IS NOT NULL GROUP BY project`,
    `SELECT project AS slug, MIN(timestamp) AS first_seen, MAX(timestamp) AS last_seen FROM documents WHERE project IS NOT NULL GROUP BY project`,
    `SELECT project AS slug, MIN(start_time) AS first_seen, MAX(start_time) AS last_seen FROM summaries WHERE project IS NOT NULL GROUP BY project`,
  ];
  const groups = new Map<string, { aliases: Set<string>; firstSeen: number; lastSeen: number }>();
  for (const sql of sources) {
    let rows: Array<{ slug: string; first_seen: number; last_seen: number }>;
    try { rows = db.prepare(sql).all() as any; }
    catch { continue; }  // table may not exist on older DBs
    for (const r of rows) {
      const canon = normalizeProjectSlug(r.slug);
      const g = groups.get(canon) ?? { aliases: new Set(), firstSeen: r.first_seen, lastSeen: r.last_seen };
      g.aliases.add(r.slug);
      g.firstSeen = Math.min(g.firstSeen, r.first_seen ?? g.firstSeen);
      g.lastSeen = Math.max(g.lastSeen, r.last_seen ?? g.lastSeen);
      groups.set(canon, g);
    }
  }
  const upsert = db.prepare(`
    INSERT INTO projects (canonical_slug, display_name, aliases, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(canonical_slug) DO UPDATE SET
      aliases = excluded.aliases,
      first_seen = MIN(projects.first_seen, excluded.first_seen),
      last_seen = MAX(projects.last_seen, excluded.last_seen)
  `);
  const tx = db.transaction(() => {
    for (const [canon, g] of groups) {
      upsert.run(canon, canon, JSON.stringify([...g.aliases].sort()), g.firstSeen, g.lastSeen);
    }
  });
  tx();
}
