/**
 * Migration tool: imports legacy data into SQLite.
 *
 * Reads:
 *   - index.msgpack (or index.json fallback) -> documents table
 *   - knowledge.json -> knowledge table
 *   - summaries/*.json -> summaries table
 *
 * Creates a .migrated marker after success. Does NOT delete legacy data.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type Database from "better-sqlite3";
import { openDatabase } from "../storage/database.js";
import { SqliteDocumentStore } from "../storage/sqlite-document-store.js";
import { SqliteKnowledgeStore } from "../storage/sqlite-knowledge-store.js";
import { SqliteSummaryStore } from "../storage/sqlite-summary-store.js";
import type { DocumentChunk } from "../indexing/document-store.js";
import type { KnowledgeEntry } from "../knowledge/knowledge-store.js";
import type { SessionSummary } from "../knowledge/session-summarizer.js";

/** Default legacy data directory */
const DEFAULT_LEGACY_DIR = join(homedir(), ".claude-history-mcp"); // Legacy path for migration

export interface MigrationOptions {
  /** Override the legacy data directory (default: ~/.claude-history-mcp/ for migration) */
  legacyDir?: string;
  /** Override the SQLite database path (default: ~/.strata/strata.db or :memory:) */
  dbPath?: string;
  /** If true, skip the .migrated marker check (force re-migration) */
  force?: boolean;
  /** Callback for progress messages (default: console.log) */
  log?: (msg: string) => void;
}

export interface MigrationResult {
  documents: number;
  sessions: number;
  knowledge: number;
  summaries: number;
  errors: string[];
  skipped: boolean;
}

/**
 * Check if legacy data exists and migration hasn't been done yet.
 */
export function shouldMigrate(legacyDir?: string): boolean {
  const dir = legacyDir ?? DEFAULT_LEGACY_DIR;
  if (!existsSync(dir)) return false;

  const markerFile = join(dir, ".migrated");
  if (existsSync(markerFile)) return false;

  // Check if there's any actual data
  const hasIndex =
    existsSync(join(dir, "index.msgpack")) ||
    existsSync(join(dir, "index.json"));
  const hasKnowledge = existsSync(join(dir, "knowledge.json"));
  const hasSummaries = existsSync(join(dir, "summaries"));

  return hasIndex || hasKnowledge || hasSummaries;
}

/**
 * Run the migration from legacy format to SQLite.
 */
export async function migrate(options: MigrationOptions = {}): Promise<MigrationResult> {
  const legacyDir = options.legacyDir ?? DEFAULT_LEGACY_DIR;
  const log = options.log ?? console.log;
  const result: MigrationResult = {
    documents: 0,
    sessions: 0,
    knowledge: 0,
    summaries: 0,
    errors: [],
    skipped: false,
  };

  // Check marker (unless force)
  if (!options.force) {
    const markerFile = join(legacyDir, ".migrated");
    if (existsSync(markerFile)) {
      log("Migration already completed (marker file exists). Use --force to re-run.");
      result.skipped = true;
      return result;
    }
  }

  if (!existsSync(legacyDir)) {
    log(`No legacy data found at ${legacyDir}`);
    result.skipped = true;
    return result;
  }

  log(`Migrating from ${legacyDir} to SQLite...`);

  // Open database
  const db = openDatabase(options.dbPath);

  try {
    const docStore = new SqliteDocumentStore(db);
    const knowledgeStore = new SqliteKnowledgeStore(db);
    const summaryStore = new SqliteSummaryStore(db);

    // 1. Migrate documents from index.msgpack or index.json
    const docResult = await migrateDocuments(legacyDir, db, docStore, log);
    result.documents = docResult.documents;
    result.sessions = docResult.sessions;
    result.errors.push(...docResult.errors);

    // 2. Migrate knowledge entries
    const knowledgeResult = migrateKnowledge(legacyDir, db, knowledgeStore, log);
    result.knowledge = knowledgeResult.count;
    result.errors.push(...knowledgeResult.errors);

    // 3. Migrate summaries
    const summaryResult = migrateSummaries(legacyDir, db, summaryStore, log);
    result.summaries = summaryResult.count;
    result.errors.push(...summaryResult.errors);

    // Write marker file
    const markerFile = join(legacyDir, ".migrated");
    writeFileSync(markerFile, JSON.stringify({
      migratedAt: new Date().toISOString(),
      documents: result.documents,
      knowledge: result.knowledge,
      summaries: result.summaries,
      errors: result.errors.length,
    }, null, 2));

    log(`Migration complete:`);
    log(`  Documents: ${result.documents} chunks from ${result.sessions} sessions`);
    log(`  Knowledge: ${result.knowledge} entries`);
    log(`  Summaries: ${result.summaries} sessions`);
    if (result.errors.length > 0) {
      log(`  Warnings: ${result.errors.length} (non-fatal)`);
    }
    log(`Legacy data preserved at ${legacyDir}`);
  } finally {
    db.close();
  }

  return result;
}

/**
 * Migrate documents from the legacy index file.
 */
async function migrateDocuments(
  legacyDir: string,
  db: Database.Database,
  store: SqliteDocumentStore,
  log: (msg: string) => void
): Promise<{ documents: number; sessions: number; errors: string[] }> {
  const errors: string[] = [];
  let documents: DocumentChunk[] = [];

  // Try msgpack first
  const msgpackPath = join(legacyDir, "index.msgpack");
  const jsonPath = join(legacyDir, "index.json");

  if (existsSync(msgpackPath)) {
    try {
      // msgpackr is an optional dependency — only needed for migration from legacy format
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { unpack } = await import(/* webpackIgnore: true */ "msgpackr" as string) as { unpack: (buf: Buffer) => unknown };
      const raw = readFileSync(msgpackPath);
      const data = unpack(raw) as { documents?: { documents?: DocumentChunk[] } };
      documents = data?.documents?.documents ?? [];
      log(`  Reading ${documents.length} documents from index.msgpack`);
    } catch (err) {
      const msg = `Warning: Could not read index.msgpack (${err instanceof Error ? err.message : String(err)}), trying JSON fallback`;
      errors.push(msg);
      log(msg);
    }
  }

  // JSON fallback
  if (documents.length === 0 && existsSync(jsonPath)) {
    try {
      const raw = readFileSync(jsonPath, "utf-8");
      const data = JSON.parse(raw) as { documents?: { documents?: DocumentChunk[] } };
      documents = data?.documents?.documents ?? [];
      log(`  Reading ${documents.length} documents from index.json`);
    } catch (err) {
      const msg = `Warning: Could not read index.json (${err instanceof Error ? err.message : String(err)})`;
      errors.push(msg);
      log(msg);
    }
  }

  if (documents.length === 0) {
    log("  No documents found to migrate");
    return { documents: 0, sessions: 0, errors };
  }

  // Insert documents in a transaction for speed
  const sessionIds = new Set<string>();
  let count = 0;

  const insertMany = db.transaction((docs: DocumentChunk[]) => {
    for (const doc of docs) {
      try {
        store.add(
          doc.text,
          doc.tokenCount,
          {
            sessionId: doc.sessionId,
            project: doc.project,
            role: doc.role,
            timestamp: doc.timestamp,
            toolNames: doc.toolNames ?? [],
            messageIndex: doc.messageIndex ?? 0,
          },
          "claude-code"
        );
        sessionIds.add(doc.sessionId);
        count++;
      } catch (err) {
        errors.push(`Warning: Failed to migrate document ${doc.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });

  insertMany(documents);
  return { documents: count, sessions: sessionIds.size, errors };
}

/**
 * Migrate knowledge entries from knowledge.json.
 */
function migrateKnowledge(
  legacyDir: string,
  db: Database.Database,
  store: SqliteKnowledgeStore,
  log: (msg: string) => void
): { count: number; errors: string[] } {
  const errors: string[] = [];
  const knowledgePath = join(legacyDir, "knowledge.json");

  if (!existsSync(knowledgePath)) {
    log("  No knowledge.json found");
    return { count: 0, errors };
  }

  let entries: KnowledgeEntry[] = [];
  try {
    const raw = readFileSync(knowledgePath, "utf-8");
    entries = JSON.parse(raw) as KnowledgeEntry[];
    if (!Array.isArray(entries)) {
      errors.push("Warning: knowledge.json is not an array");
      return { count: 0, errors };
    }
  } catch (err) {
    const msg = `Warning: Could not read knowledge.json (${err instanceof Error ? err.message : String(err)})`;
    errors.push(msg);
    log(msg);
    return { count: 0, errors };
  }

  log(`  Migrating ${entries.length} knowledge entries`);
  let count = 0;

  const insertMany = db.transaction((items: KnowledgeEntry[]) => {
    for (const entry of items) {
      try {
        store.addEntry(entry);
        count++;
      } catch (err) {
        errors.push(`Warning: Failed to migrate knowledge entry ${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });

  insertMany(entries);
  return { count, errors };
}

/**
 * Migrate session summaries from summaries/*.json.
 */
function migrateSummaries(
  legacyDir: string,
  db: Database.Database,
  store: SqliteSummaryStore,
  log: (msg: string) => void
): { count: number; errors: string[] } {
  const errors: string[] = [];
  const summariesDir = join(legacyDir, "summaries");

  if (!existsSync(summariesDir)) {
    log("  No summaries directory found");
    return { count: 0, errors };
  }

  let files: string[];
  try {
    files = readdirSync(summariesDir).filter((f) => f.endsWith(".json"));
  } catch (err) {
    const msg = `Warning: Could not read summaries directory (${err instanceof Error ? err.message : String(err)})`;
    errors.push(msg);
    log(msg);
    return { count: 0, errors };
  }

  if (files.length === 0) {
    log("  No summary files found");
    return { count: 0, errors };
  }

  log(`  Migrating ${files.length} session summaries`);
  let count = 0;

  const insertMany = db.transaction((filesToProcess: string[]) => {
    for (const file of filesToProcess) {
      try {
        const raw = readFileSync(join(summariesDir, file), "utf-8");
        const summary = JSON.parse(raw) as SessionSummary;
        store.save(summary, "claude-code");
        count++;
      } catch (err) {
        errors.push(`Warning: Could not migrate summary ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });

  insertMany(files);
  return { count, errors };
}

/**
 * Auto-migrate on first startup if legacy data exists.
 * Called from server startup. Non-blocking — logs errors but does not throw.
 */
export async function autoMigrate(options: MigrationOptions = {}): Promise<void> {
  const legacyDir = options.legacyDir ?? DEFAULT_LEGACY_DIR;
  const log = options.log ?? console.log;

  if (!shouldMigrate(legacyDir)) return;

  try {
    log("Legacy data detected. Running auto-migration...");
    await migrate({ ...options, legacyDir });
  } catch (err) {
    log(`Auto-migration failed: ${err instanceof Error ? err.message : String(err)}`);
    log("You can retry with: strata migrate");
  }
}

// CLI entry point
if (process.argv[1] && process.argv[1].includes("migrate")) {
  const force = process.argv.includes("--force");
  migrate({ force }).catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
