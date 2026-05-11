/**
 * backfill-junction.ts — Backfill CLI: strata index --backfill-junction
 *
 * Reconstructs missing knowledge_entities junction rows from existing
 * knowledge entries. For each entry in the `knowledge` table, re-extracts
 * entities from `summary + details` text and writes (entry_id, entity_id)
 * rows using INSERT OR IGNORE (idempotent).
 *
 * Use case: production databases where entities and entity_relations are
 * populated (from past file-watcher runs) but knowledge_entities is empty
 * because store_memory never called linkToKnowledge() before v2.2.1.
 *
 * Options:
 *   --project=name   Restrict to a single project
 *   --dry-run        Report counts without writing to knowledge_entities
 *
 * Progress format:
 *   [N/total] entry=<id> entities=<count>
 *
 * Idempotent: running twice produces the same final state.
 * INSERT OR IGNORE ensures no duplicate (entry_id, entity_id) pairs.
 *
 * Ticket: knowledge_entities junction write-path fix (strata-mcp@2.2.1)
 */

import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import type { IEntityStore } from "../storage/interfaces/entity-store.js";
import { extractEntities } from "../knowledge/entity-extractor.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BackfillJunctionOptions {
  /** Open SQLite database handle (with full Strata schema). */
  db: Database.Database;
  /** Entity store to write entities and junction rows into. */
  entityStore: IEntityStore;
  /** Optional project filter. When set, only entries in this project are processed. */
  project?: string;
  /** When true, report counts but do not write to knowledge_entities. */
  dryRun?: boolean;
  /** Optional output sink (defaults to process.stdout). Useful for testing. */
  log?: (line: string) => void;
}

export interface BackfillJunctionResult {
  entriesProcessed: number;
  junctionRowsWritten: number;
  elapsedMs: number;
}

// ── Row shape from the knowledge query ───────────────────────────────────────

interface KnowledgeRow {
  id: string;
  project: string;
  summary: string;
  details: string;
}

// ── Core function (exported for direct use in tests and CLI) ──────────────────

/**
 * Backfill knowledge_entities junction rows from existing knowledge entries.
 *
 * For every knowledge entry in scope:
 * 1. Extract entities from `summary + details` text.
 * 2. Upsert each entity into the `entities` table.
 * 3. INSERT OR IGNORE into `knowledge_entities` (idempotent).
 *
 * Returns a summary suitable for progress reporting.
 */
export async function backfillJunction(
  opts: BackfillJunctionOptions
): Promise<BackfillJunctionResult> {
  const { db, entityStore, project, dryRun = false, log = console.log } = opts;
  const startMs = Date.now();

  // ── 1. Enumerate knowledge entries in scope ────────────────────────────────

  let sql = "SELECT id, project, summary, details FROM knowledge";
  const params: string[] = [];

  if (project) {
    sql += " WHERE project = ?";
    params.push(project);
  }

  sql += " ORDER BY id";

  const rows = db.prepare(sql).all(...params) as KnowledgeRow[];

  if (rows.length === 0) {
    log("[backfill-junction] No knowledge entries found.");
    return { entriesProcessed: 0, junctionRowsWritten: 0, elapsedMs: Date.now() - startMs };
  }

  const total = rows.length;
  let entriesProcessed = 0;
  let junctionRowsWritten = 0;

  // ── 2. Process each entry ──────────────────────────────────────────────────

  const now = Date.now();

  for (let i = 0; i < rows.length; i++) {
    const { id: entryId, project: entryProject, summary, details } = rows[i];
    const text = `${summary} ${details}`;
    const entities = extractEntities(text);

    entriesProcessed++;

    if (entities.length === 0) {
      log(`[${i + 1}/${total}] entry=${entryId.slice(0, 8)} entities=0`);
      continue;
    }

    log(`[${i + 1}/${total}] entry=${entryId.slice(0, 8)} entities=${entities.length}${dryRun ? " [dry-run]" : ""}`);

    if (!dryRun) {
      for (const extracted of entities) {
        try {
          const entityId = await entityStore.upsertEntity({
            id: randomUUID(),
            name: extracted.name,
            type: extracted.type,
            canonicalName: extracted.canonicalName,
            aliases: [extracted.name.toLowerCase()],
            firstSeen: now,
            lastSeen: now,
            project: entryProject,
          });
          await entityStore.linkToKnowledge(entryId, entityId);
          junctionRowsWritten++;
        } catch {
          // Entity errors are non-fatal — log and continue
          log(`[backfill-junction] Warning: entity upsert failed for entry ${entryId}`);
        }
      }
    } else {
      // Dry-run: count without writing
      junctionRowsWritten += entities.length;
    }
  }

  const elapsedMs = Date.now() - startMs;

  // ── 3. Summary ────────────────────────────────────────────────────────────

  log(
    `[backfill-junction] ${dryRun ? "[dry-run] " : ""}Done: ${entriesProcessed} entries processed, ` +
    `${junctionRowsWritten} junction rows ${dryRun ? "would be written" : "written"} in ${elapsedMs}ms`
  );

  return { entriesProcessed, junctionRowsWritten, elapsedMs };
}

// ── CLI entry (called from strata/src/cli.ts `case "index":`) ─────────────────

export async function runBackfillJunction(
  flags: Record<string, string | boolean>
): Promise<void> {
  const { openDatabase } = await import("../storage/database.js");
  const { SqliteEntityStore } = await import("../storage/sqlite-entity-store.js");

  const db = openDatabase();
  const entityStore = new SqliteEntityStore(db);

  const project = flags.project ? String(flags.project) : undefined;
  const dryRun = Boolean(flags["dry-run"]);

  try {
    const result = await backfillJunction({ db, entityStore, project, dryRun });
    console.log(
      `\nSummary: ${result.entriesProcessed} entries processed, ` +
      `${result.junctionRowsWritten} junction rows ${dryRun ? "found (dry-run)" : "written"} ` +
      `in ${result.elapsedMs}ms`
    );
  } finally {
    db.close();
  }
}
