/**
 * `strata rest-migrate --player-id <uuid> [--dry-run]`
 *
 * Migrates flat REST-transport agent directories from the pre-scoping
 * layout ({baseDir}/<agentId>/strata.db) to the per-player layout
 * ({baseDir}/players/<playerId>/agents/<agentId>/strata.db).
 *
 * Spec: 2026-04-11-per-player-npc-scoping-design.md Section 4.
 */

import { existsSync, readdirSync, renameSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface RestMigrateOptions {
  baseDir: string;
  playerId: string;
  dryRun: boolean;
}

export interface RestMigrateResult {
  moved: string[];
  skipped: string[];
  dryRun: boolean;
  targetDir: string;
}

const RESERVED_NAMES = new Set(["players", "sessions"]);
const REGISTRY_FILE = "players.json";

/**
 * Scan `baseDir` for top-level agent directories (each containing a
 * `strata.db` file) and move them under `baseDir/players/<playerId>/agents/`.
 *
 * Skips: `players/`, `sessions/`, `players.json`, and directories without
 * a `strata.db` file inside.
 */
export function runRestMigrate(options: RestMigrateOptions): RestMigrateResult {
  const { baseDir, playerId, dryRun } = options;
  const targetDir = join(baseDir, "players", playerId, "agents");

  if (!existsSync(baseDir)) {
    throw new Error(`baseDir does not exist: ${baseDir}`);
  }

  const existingTarget = join(baseDir, "players", playerId);
  if (existsSync(existingTarget) && !dryRun) {
    throw new Error(
      `Target player directory already exists: ${existingTarget}. Refusing to merge — delete it first or pick a different --player-id.`
    );
  }

  const moved: string[] = [];
  const skipped: string[] = [];

  for (const name of readdirSync(baseDir)) {
    if (RESERVED_NAMES.has(name) || name === REGISTRY_FILE) continue;
    const abs = join(baseDir, name);
    const stat = statSync(abs);
    if (!stat.isDirectory()) {
      skipped.push(name);
      continue;
    }
    const dbPath = join(abs, "strata.db");
    if (!existsSync(dbPath)) {
      skipped.push(name);
      continue;
    }

    moved.push(name);
    if (!dryRun) {
      mkdirSync(targetDir, { recursive: true });
      renameSync(abs, join(targetDir, name));
    }
  }

  return { moved, skipped, dryRun, targetDir };
}
