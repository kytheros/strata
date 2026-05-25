import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/storage/database.js";
import { normalizeProjectSlug, canonicalProject, backfillProjects, listProjects } from "../../src/storage/projects.js";

describe("normalizeProjectSlug", () => {
  it("converts Windows directory slug (E--strata) to forward-slash", () => {
    expect(normalizeProjectSlug("E--strata")).toBe("E:/strata");
  });
  it("converts backslash to forward slash", () => {
    expect(normalizeProjectSlug("E:\\strata")).toBe("E:/strata");
  });
  it("de-dupes trailing segment (E:/strata/strata)", () => {
    expect(normalizeProjectSlug("E:/strata/strata")).toBe("E:/strata");
  });
  it("case-folds bare slugs", () => {
    expect(normalizeProjectSlug("Kytheros")).toBe("kytheros");
    expect(normalizeProjectSlug("KYTHEROS")).toBe("kytheros");
  });
  it("preserves case for path-like slugs", () => {
    expect(normalizeProjectSlug("E--Kytheros")).toBe("E:/Kytheros");
  });
  it("returns 'unknown' for empty/null", () => {
    expect(normalizeProjectSlug("")).toBe("unknown");
    expect(normalizeProjectSlug(null as any)).toBe("unknown");
  });
});

describe("canonicalProject", () => {
  let dbPath: string;
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "strata-proj-"));
    dbPath = join(dir, "test.db");
  });

  it("inserts a new row when alias is unknown", () => {
    const db = openDatabase(dbPath);
    const slug = canonicalProject("E--strata", db);
    expect(slug).toBe("E:/strata");
    const row = db.prepare("SELECT * FROM projects WHERE canonical_slug = ?").get("E:/strata") as any;
    expect(row).toBeTruthy();
    expect(JSON.parse(row.aliases)).toContain("E--strata");
    db.close();
  });

  it("returns the canonical slug for a known alias", () => {
    const db = openDatabase(dbPath);
    canonicalProject("E--strata", db);
    const slug = canonicalProject("E:\\strata", db);
    expect(slug).toBe("E:/strata");
    const row = db.prepare("SELECT aliases FROM projects WHERE canonical_slug = 'E:/strata'").get() as any;
    expect(JSON.parse(row.aliases).sort()).toEqual(["E--strata", "E:\\strata"]);
    db.close();
  });
});

describe("backfillProjects", () => {
  it("populates projects from UNION across content tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-bf-"));
    const db = openDatabase(join(dir, "test.db"));
    const now = Date.now();
    db.prepare("INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details, tags, related_files, importance) VALUES (?, 'fact', 'E--strata', 's1', ?, 'x', 'y', '[]', '[]', 0.5)").run("k1", now);
    db.prepare("INSERT INTO analytics (event_type, event_data, project, timestamp) VALUES ('search', '{}', 'E:\\strata', ?)").run(now);
    db.prepare("INSERT INTO entities (id, name, type, canonical_name, aliases, first_seen, last_seen, mention_count, project) VALUES ('e1', 'x', 'concept', 'x', '[\"x\"]', ?, ?, 1, 'E:/strata')").run(now, now);

    backfillProjects(db);

    const rows = listProjects(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].canonical_slug).toBe("E:/strata");
    expect(rows[0].aliases.sort()).toEqual(["E--strata", "E:/strata", "E:\\strata"]);
    db.close();
  });
});
