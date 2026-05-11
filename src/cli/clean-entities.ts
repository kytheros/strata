/**
 * clean-entities.ts — One-time cleanup CLI: strata index --clean-entities
 *
 * Identifies and removes entity-graph pollution caused by the entity extractor
 * matching XML/HTML-like tag patterns from Claude Code system-reminder formatting
 * as if they were npm package names. Polluted entities include:
 *
 *   tool-use-id, task-notification, task-id, ask-id,
 *   command-message, command-args, command-name,
 *   ommand-message, ommand-args, ommand-name  (partial-strip artifacts)
 *
 * For each matched entity:
 *   1. DELETE junction rows in knowledge_entities referencing this entity.
 *   2. DELETE the entity from the entities table.
 *   3. DELETE any entity_relations rows referencing this entity.
 *
 * Idempotent: running twice gives the same final state.
 * Reports entity_count and junction_row_count removed.
 *
 * Options:
 *   --dry-run       Report counts without writing to the database
 *   --project=name  Restrict to entities in a single project (optional)
 *
 * Ticket: entity extractor pollution fix (strata-mcp@2.2.2)
 */

import type Database from "better-sqlite3";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CleanEntitiesOptions {
  /** Open SQLite database handle (with full Strata schema). */
  db: Database.Database;
  /** When true, report counts but do not write any changes. */
  dryRun?: boolean;
  /** Optional project filter. When set, only entities in this project are considered. */
  project?: string;
  /** Optional output sink (defaults to console.log). */
  log?: (line: string) => void;
}

export interface CleanEntitiesResult {
  entitiesRemoved: number;
  junctionRowsRemoved: number;
  relationsRemoved: number;
  elapsedMs: number;
}

// ── Heuristic: which canonical names are tag-fragment pollution ───────────────

/**
 * Returns true when a canonical entity name is a known tag-fragment artifact.
 *
 * Detection heuristic: the canonical name matches one of the known system-reminder
 * tag names OR their partial-strip variants (where the leading '<' was consumed
 * by the lookbehind in NPM_PATTERN but the rest of the tag body was matched).
 *
 * Deliberately narrow: only the specific patterns observed in production.
 * We do NOT try to catch all hyphenated-tag-looking strings because that
 * would risk removing legitimate npm packages.
 */
export function isTagFragment(canonicalName: string): boolean {
  const name = canonicalName.toLowerCase().trim();

  // Exact matches — known Claude Code system-reminder tag names
  const EXACT_DENYLIST = new Set([
    "tool-use-id",
    "task-notification",
    "task-id",
    "ask-id",
    "command-message",
    "command-args",
    "command-name",
    "system-reminder",
    // Partial-strip artifacts
    "ommand-message",
    "ommand-args",
    "ommand-name",
    "ool-use-id",
    "ask-notification",
    // Other Claude Code tool formatting tags
    "tool-result",
    "tool-call",
    "invoke-tool",
    "function-calls",
    "function-call",
    "antml-function",
  ]);

  if (EXACT_DENYLIST.has(name)) return true;

  // Pattern match: starts with "o" followed by "mmand-" (all "ommand-*" variants)
  // This catches any new ommand-* suffix that wasn't enumerated above.
  if (/^ommand-/.test(name)) return true;

  // Pattern match: ends with "-id" AND appears to be a tag fragment
  // (i.e. no legitimate npm package would be just "*-id" with nothing else)
  // Only the ones we've explicitly seen: task-id, tool-use-id, ask-id, ool-use-id
  // We don't use a blanket "-id" filter to avoid false positives.
  if (/^(?:task|ask|ool-use|tool-use)[-]id$/.test(name)) return true;

  return false;
}

// ── Row shape ─────────────────────────────────────────────────────────────────

interface EntityRow {
  id: string;
  canonical_name: string;
  project: string | null;
}

// ── Core function ─────────────────────────────────────────────────────────────

/**
 * Scan the entities table for tag-fragment pollution and remove matching rows.
 *
 * For each identified entity:
 *   1. Count + delete knowledge_entities junction rows.
 *   2. Count + delete entity_relations rows (both source and target sides).
 *   3. Delete the entity row itself.
 *
 * In dry-run mode, counts are reported but no mutations are made.
 */
export async function cleanEntities(
  opts: CleanEntitiesOptions
): Promise<CleanEntitiesResult> {
  const { db, dryRun = false, project, log = console.log } = opts;
  const startMs = Date.now();

  // ── 1. Query all entities (optionally filtered by project) ────────────────

  let sql = "SELECT id, canonical_name, project FROM entities";
  const params: (string | null)[] = [];

  if (project) {
    sql += " WHERE project = ?";
    params.push(project);
  }

  const rows = db.prepare(sql).all(...params) as EntityRow[];

  if (rows.length === 0) {
    log("[clean-entities] No entities found.");
    return { entitiesRemoved: 0, junctionRowsRemoved: 0, relationsRemoved: 0, elapsedMs: Date.now() - startMs };
  }

  // ── 2. Identify pollution candidates ─────────────────────────────────────

  const polluted = rows.filter((r) => isTagFragment(r.canonical_name));

  if (polluted.length === 0) {
    log(`[clean-entities] Scanned ${rows.length} entities — no tag-fragment pollution found.`);
    return { entitiesRemoved: 0, junctionRowsRemoved: 0, relationsRemoved: 0, elapsedMs: Date.now() - startMs };
  }

  log(
    `[clean-entities] Found ${polluted.length} tag-fragment entit${polluted.length === 1 ? "y" : "ies"} ` +
    `out of ${rows.length} total${dryRun ? " [dry-run]" : ""}.`
  );

  // ── 3. Remove each polluted entity ───────────────────────────────────────

  let junctionRowsRemoved = 0;
  let relationsRemoved = 0;

  const countJunction = db.prepare(
    "SELECT COUNT(*) as n FROM knowledge_entities WHERE entity_id = ?"
  );
  const deleteJunction = db.prepare(
    "DELETE FROM knowledge_entities WHERE entity_id = ?"
  );
  const countRelations = db.prepare(
    "SELECT COUNT(*) as n FROM entity_relations WHERE source_entity_id = ? OR target_entity_id = ?"
  );
  const deleteRelations = db.prepare(
    "DELETE FROM entity_relations WHERE source_entity_id = ? OR target_entity_id = ?"
  );
  const deleteEntity = db.prepare(
    "DELETE FROM entities WHERE id = ?"
  );

  for (const entity of polluted) {
    const jCount = (countJunction.get(entity.id) as { n: number }).n;
    const rCount = (countRelations.get(entity.id, entity.id) as { n: number }).n;

    log(
      `[clean-entities] ${dryRun ? "[dry-run] " : ""}Removing entity "${entity.canonical_name}" ` +
      `(id=${entity.id.slice(0, 8)}) ` +
      `— ${jCount} junction row${jCount !== 1 ? "s" : ""}, ${rCount} relation${rCount !== 1 ? "s" : ""}`
    );

    junctionRowsRemoved += jCount;
    relationsRemoved += rCount;

    if (!dryRun) {
      deleteJunction.run(entity.id);
      deleteRelations.run(entity.id, entity.id);
      deleteEntity.run(entity.id);
    }
  }

  const elapsedMs = Date.now() - startMs;

  log(
    `[clean-entities] ${dryRun ? "[dry-run] " : ""}Done: ` +
    `${polluted.length} entit${polluted.length === 1 ? "y" : "ies"} ${dryRun ? "would be removed" : "removed"}, ` +
    `${junctionRowsRemoved} junction row${junctionRowsRemoved !== 1 ? "s" : ""} ${dryRun ? "would be removed" : "removed"}, ` +
    `${relationsRemoved} relation${relationsRemoved !== 1 ? "s" : ""} ${dryRun ? "would be removed" : "removed"} ` +
    `in ${elapsedMs}ms`
  );

  return {
    entitiesRemoved: polluted.length,
    junctionRowsRemoved,
    relationsRemoved,
    elapsedMs,
  };
}

// ── CLI entry (called from strata/src/cli.ts `case "index":`) ─────────────────

export async function runCleanEntities(
  flags: Record<string, string | boolean>
): Promise<void> {
  const { openDatabase } = await import("../storage/database.js");

  const db = openDatabase();
  const project = flags.project ? String(flags.project) : undefined;
  const dryRun = Boolean(flags["dry-run"]);

  try {
    const result = await cleanEntities({ db, project, dryRun });
    console.log(
      `\nSummary: ${result.entitiesRemoved} entit${result.entitiesRemoved !== 1 ? "ies" : "y"} ${dryRun ? "found (dry-run)" : "removed"}, ` +
      `${result.junctionRowsRemoved} junction row${result.junctionRowsRemoved !== 1 ? "s" : ""} ${dryRun ? "found" : "removed"}, ` +
      `${result.relationsRemoved} relation${result.relationsRemoved !== 1 ? "s" : ""} ${dryRun ? "found" : "removed"} ` +
      `in ${result.elapsedMs}ms`
    );
  } finally {
    db.close();
  }
}
