/**
 * rebuild-turns.ts — Backfill CLI: strata index --rebuild-turns
 *
 * Walks all session files registered in the `documents` table, grouped by
 * session_id, invokes parseTurns() per file, and writes results to
 * `knowledge_turns`. Idempotent — running twice produces the same final state
 * (existing rows for a session are deleted before re-insertion).
 *
 * Options:
 *   --project=name   Restrict to a single project (filters documents table)
 *   --dry-run        Report counts without writing to knowledge_turns
 *
 * Progress format:
 *   [N/total] {parser} session={id} turns={count}
 *
 * Per TIRQDP-1.9. Spec: 2026-05-01-tirqdp-community-port-plan.md
 *
 * Async coordination note:
 *   All turnStore.* calls are awaited so that this code works with both the
 *   current synchronous implementation (await of a non-Promise resolves
 *   immediately) and any future async refactor.
 */

import type Database from "better-sqlite3";
import type { IKnowledgeTurnStore } from "../storage/interfaces/knowledge-turn-store.js";
import type { ParserRegistry } from "../parsers/parser-registry.js";
import type { SessionFileInfo } from "../parsers/session-parser.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RebuildTurnsOptions {
  /** Open SQLite database handle (with full Strata schema). */
  db: Database.Database;
  /** Turn store to write into. */
  turnStore: IKnowledgeTurnStore;
  /** Parser registry providing discover() + parseTurns() per tool. */
  registry: ParserRegistry;
  /** Optional project filter. When set, only sessions in this project are processed. */
  project?: string;
  /** When true, report counts but do not write to knowledge_turns. */
  dryRun?: boolean;
  /** Optional output sink (defaults to process.stdout). Useful for testing. */
  log?: (line: string) => void;
}

export interface RebuildTurnsResult {
  sessionsProcessed: number;
  turnsWritten: number;
  elapsedMs: number;
}

// ── Row shape from the documents query ───────────────────────────────────────

interface SessionRow {
  session_id: string;
  project: string;
  tool: string;
}

// ── Core function (exported for direct use in tests and CLI) ──────────────────

/**
 * Rebuild knowledge_turns from all indexed sessions.
 *
 * Returns a summary suitable for progress reporting.
 */
export async function rebuildTurns(opts: RebuildTurnsOptions): Promise<RebuildTurnsResult> {
  const { db, turnStore, registry, project, dryRun = false, log = console.log } = opts;
  const startMs = Date.now();

  // ── 1. Enumerate distinct sessions from the documents table ──────────────────

  let sql = `
    SELECT DISTINCT session_id, project, tool
    FROM documents
  `;
  const params: string[] = [];

  if (project) {
    sql += " WHERE project = ?";
    params.push(project);
  }

  sql += " ORDER BY session_id";

  const sessionRows = db.prepare(sql).all(...params) as SessionRow[];

  if (sessionRows.length === 0) {
    log("[rebuild-turns] No sessions found in documents table.");
    return { sessionsProcessed: 0, turnsWritten: 0, elapsedMs: Date.now() - startMs };
  }

  // ── 2. Build a map from {parserId → {sessionId → SessionFileInfo}} ───────────
  //       by calling discover() on each parser once and indexing by session_id.

  // Gather parser ids referenced in the DB
  const parserIds = new Set(sessionRows.map((r) => r.tool));

  // For each parser, call discover() and index the results by session_id
  const fileInfoIndex = new Map<string, Map<string, SessionFileInfo>>();
  // {parserId → Map<sessionId, SessionFileInfo>}

  for (const parserId of parserIds) {
    const parser = registry.getById(parserId);
    if (!parser) continue;

    const discovered = parser.discover();
    const bySessionId = new Map<string, SessionFileInfo>();
    for (const fi of discovered) {
      bySessionId.set(fi.sessionId, fi);
    }
    fileInfoIndex.set(parserId, bySessionId);
  }

  // ── 3. Process each session ───────────────────────────────────────────────────

  let sessionsProcessed = 0;
  let turnsWritten = 0;
  const total = sessionRows.length;

  for (let i = 0; i < sessionRows.length; i++) {
    const { session_id: sessionId, project: sessionProject, tool: parserId } = sessionRows[i];

    const parser = registry.getById(parserId);
    if (!parser) {
      // No parser registered for this tool — skip silently
      continue;
    }

    // Look up the file info from the discovery index
    const bySessionId = fileInfoIndex.get(parserId);
    const fileInfo = bySessionId?.get(sessionId);

    if (!fileInfo) {
      // File no longer exists on disk (deleted) — skip
      continue;
    }

    // Parse turns from file
    const messages = await parser.parseTurns(fileInfo);
    const turnCount = messages.length;

    log(`[${i + 1}/${total}] ${parserId} session=${sessionId} turns=${turnCount}`);

    sessionsProcessed++;
    turnsWritten += turnCount;

    if (!dryRun) {
      // Delete existing turns for this session (idempotency)
      await turnStore.deleteBySessionId(sessionId);

      if (turnCount > 0) {
        // Bulk-insert new turns
        await turnStore.bulkInsert(
          messages.map((msg, idx) => ({
            sessionId,
            project: sessionProject ?? null,
            userId: null,
            speaker: msg.role === "user" ? "user" : "assistant",
            content: msg.text,
            messageIndex: idx,
          }))
        );
      }
    }
  }

  const elapsedMs = Date.now() - startMs;

  // ── 4. Summary ───────────────────────────────────────────────────────────────

  log(
    `[rebuild-turns] ${dryRun ? "[dry-run] " : ""}Done: ${sessionsProcessed} sessions, ${turnsWritten} turns in ${elapsedMs}ms`
  );

  return { sessionsProcessed, turnsWritten, elapsedMs };
}

// ── CLI entry (called from strata/src/cli.ts `case "index":`) ────────────────

export async function runRebuildTurns(
  flags: Record<string, string | boolean>
): Promise<void> {
  const { openDatabase } = await import("../storage/database.js");
  const { SqliteKnowledgeTurnStore } = await import(
    "../storage/sqlite-knowledge-turn-store.js"
  );
  const { SqliteIndexManager } = await import(
    "../indexing/sqlite-index-manager.js"
  );

  const db = openDatabase();
  const turnStore = new SqliteKnowledgeTurnStore(db);

  // SqliteIndexManager owns the parser registry
  const indexManager = new SqliteIndexManager();
  const registry = indexManager.registry;

  const project = flags.project ? String(flags.project) : undefined;
  const dryRun = Boolean(flags["dry-run"]);

  try {
    const result = await rebuildTurns({ db, turnStore, registry, project, dryRun });
    console.log(
      `\nSummary: ${result.sessionsProcessed} sessions processed, ` +
        `${result.turnsWritten} turns ${dryRun ? "found (dry-run)" : "written"} ` +
        `in ${result.elapsedMs}ms`
    );
  } finally {
    indexManager.close();
    db.close();
  }
}
