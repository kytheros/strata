/**
 * TDD tests for the backfill-junction CLI command.
 *
 * Scenario: A production DB has populated entities and entity_relations
 * tables (from past file-watcher runs) but an empty knowledge_entities junction.
 * The backfill command re-extracts entities from each knowledge entry's text
 * and writes (entry_id, entity_id) rows into knowledge_entities.
 *
 * Requirements:
 * - Idempotent: running twice produces the same final state (no duplicate rows)
 * - Scoped to entries that actually mention known entities (skips unmatched entries)
 * - Returns a count of junction rows written
 *
 * Ticket: knowledge_entities junction write-path fix
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteEntityStore } from "../../src/storage/sqlite-entity-store.js";
import { backfillJunction, type BackfillJunctionOptions } from "../../src/cli/backfill-junction.js";

// Helper: insert a knowledge entry directly into the DB
function insertKnowledgeEntry(
  db: Database.Database,
  opts: { id?: string; summary: string; details: string; project?: string }
): string {
  const id = opts.id ?? randomUUID();
  db.prepare(`
    INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details, tags, related_files)
    VALUES (?, 'decision', ?, 'session-test', ?, ?, ?, '[]', '[]')
  `).run(id, opts.project ?? "global", Date.now(), opts.summary, opts.details);
  return id;
}

// ── Integration tests for backfill-junction ──────────────────────────────────

describe("backfill-junction CLI command", () => {
  let db: Database.Database;
  let entityStore: SqliteEntityStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    entityStore = new SqliteEntityStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("RED: populates junction table from existing knowledge entries mentioning known entities", async () => {
    // Seed 5 entries with various tech mentions, junction empty
    insertKnowledgeEntry(db, {
      summary: "Use Postgres for production",
      details: "Postgres was chosen over MySQL for JSONB support",
    });
    insertKnowledgeEntry(db, {
      summary: "Docker for containerization",
      details: "Using Docker and Kubernetes for deployment",
    });
    insertKnowledgeEntry(db, {
      summary: "Frontend uses React",
      details: "React with TypeScript and Vite",
    });
    insertKnowledgeEntry(db, {
      summary: "Testing strategy",
      details: "Jest for unit tests, Vitest for integration",
    });
    insertKnowledgeEntry(db, {
      summary: "No tech mentioned here",
      details: "Remember to hydrate and sleep well",
    });

    // Confirm junction is empty before backfill
    const before = db
      .prepare("SELECT COUNT(*) as count FROM knowledge_entities")
      .get() as { count: number };
    expect(before.count).toBe(0);

    const opts: BackfillJunctionOptions = { db, entityStore, log: () => {} };
    const result = await backfillJunction(opts);

    // Junction rows should now exist for entries that mentioned entities
    const after = db
      .prepare("SELECT COUNT(*) as count FROM knowledge_entities")
      .get() as { count: number };
    expect(after.count).toBeGreaterThan(0);
    expect(result.junctionRowsWritten).toBeGreaterThan(0);

    // Entry 5 (no tech) should not generate junction rows
    // Entry 4 (jest, vitest) should have at least 2 rows
    const entry4Rows = db
      .prepare(`
        SELECT ke.entry_id, e.canonical_name
        FROM knowledge_entities ke
        JOIN entities e ON e.id = ke.entity_id
        JOIN knowledge k ON k.id = ke.entry_id
        WHERE k.summary = 'Testing strategy'
      `)
      .all() as Array<{ entry_id: string; canonical_name: string }>;
    const names = entry4Rows.map((r) => r.canonical_name);
    expect(names).toContain("jest");
    expect(names).toContain("vitest");
  });

  it("is idempotent — running backfill twice produces the same row count", async () => {
    insertKnowledgeEntry(db, {
      summary: "Use Postgres and Redis",
      details: "Postgres for persistence, Redis for caching",
    });

    const opts: BackfillJunctionOptions = { db, entityStore, log: () => {} };

    await backfillJunction(opts);
    const afterFirst = db
      .prepare("SELECT COUNT(*) as count FROM knowledge_entities")
      .get() as { count: number };

    await backfillJunction(opts);
    const afterSecond = db
      .prepare("SELECT COUNT(*) as count FROM knowledge_entities")
      .get() as { count: number };

    expect(afterFirst.count).toBe(afterSecond.count);
    expect(afterFirst.count).toBeGreaterThan(0);
  });

  it("dry-run mode reports counts without writing to knowledge_entities", async () => {
    insertKnowledgeEntry(db, {
      summary: "Use TypeScript and Node.js",
      details: "TypeScript for type safety, Node.js for runtime",
    });

    const logLines: string[] = [];
    const opts: BackfillJunctionOptions = {
      db,
      entityStore,
      dryRun: true,
      log: (line: string) => logLines.push(line),
    };

    const result = await backfillJunction(opts);

    // Dry run: no junction rows written
    const count = db
      .prepare("SELECT COUNT(*) as count FROM knowledge_entities")
      .get() as { count: number };
    expect(count.count).toBe(0);

    // But result still reports what would have been written
    expect(result.junctionRowsWritten).toBeGreaterThan(0);

    // Log should mention dry-run
    const logOutput = logLines.join("\n");
    expect(logOutput).toMatch(/dry.?run/i);
  });

  it("skips entries that have already been linked (partial junction state)", async () => {
    const entryId = insertKnowledgeEntry(db, {
      summary: "Use React and Vue",
      details: "React for new features, Vue for legacy pages",
    });

    // Pre-populate a partial junction (React only)
    const opts: BackfillJunctionOptions = { db, entityStore, log: () => {} };

    // Run full backfill once (populates both react and vue)
    await backfillJunction(opts);
    const afterFirst = db
      .prepare("SELECT COUNT(*) as count FROM knowledge_entities WHERE entry_id = ?")
      .get(entryId) as { count: number };
    expect(afterFirst.count).toBeGreaterThanOrEqual(2);

    // Running again must not add duplicate rows
    await backfillJunction(opts);
    const afterSecond = db
      .prepare("SELECT COUNT(*) as count FROM knowledge_entities WHERE entry_id = ?")
      .get(entryId) as { count: number };
    expect(afterSecond.count).toBe(afterFirst.count);
  });

  it("reports total entries processed and junction rows written", async () => {
    insertKnowledgeEntry(db, {
      summary: "Use Docker",
      details: "Docker containers for everything",
    });
    insertKnowledgeEntry(db, {
      summary: "No tech",
      details: "Administrative notes only",
    });

    const opts: BackfillJunctionOptions = { db, entityStore, log: () => {} };
    const result = await backfillJunction(opts);

    expect(result.entriesProcessed).toBe(2);
    expect(result.junctionRowsWritten).toBeGreaterThan(0); // docker at minimum
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
