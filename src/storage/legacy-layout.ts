/**
 * Legacy layout detection for the world-scope refactor guard.
 *
 * The pre-refactor FS-tree layout used JSON files to store NPC profiles,
 * player character data, and relationship data. The post-refactor layout uses
 * SQLite databases (`strata.db`) and has no JSON marker files.
 *
 * This predicate distinguishes the two layouts so that `strata serve --rest`
 * can refuse to start against genuinely pre-refactor data without blocking
 * valid post-refactor no-auth data dirs that legitimately contain a
 * `players/` subdirectory.
 *
 * Pre-refactor markers (any one is sufficient):
 *   {basePath}/agents/{npcId}/profile.json
 *   {basePath}/players/{playerId}/character.json
 *   {basePath}/players/{playerId}/agents/{npcId}/relationship.json
 *
 * Post-refactor (current, no-auth):
 *   {basePath}/players/{playerId}/agents/{npcId}/strata.db
 *   (no JSON marker files)
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Returns `true` if `basePath` contains a pre-refactor JSON-tree layout that
 * requires `strata world-migrate` before the server can start.
 *
 * Returns `false` for empty dirs, already-migrated dirs (`worlds/`), and
 * post-refactor no-auth dirs that contain only SQLite databases under
 * `players/`.
 */
export function hasLegacyLayout(basePath: string): boolean {
  // 1. Check for agents/{npcId}/profile.json
  const agentsDir = join(basePath, "agents");
  if (existsSync(agentsDir)) {
    try {
      for (const npcId of readdirSync(agentsDir)) {
        if (existsSync(join(agentsDir, npcId, "profile.json"))) {
          return true;
        }
      }
    } catch {
      // ignore read errors
    }
  }

  // 2. Check for players/{playerId}/character.json
  //    and players/{playerId}/agents/{npcId}/relationship.json
  const playersDir = join(basePath, "players");
  if (existsSync(playersDir)) {
    try {
      for (const playerId of readdirSync(playersDir)) {
        const playerDir = join(playersDir, playerId);

        // Pre-refactor player character marker
        if (existsSync(join(playerDir, "character.json"))) {
          return true;
        }

        // Pre-refactor relationship marker
        const playerAgentsDir = join(playerDir, "agents");
        if (existsSync(playerAgentsDir)) {
          try {
            for (const npcId of readdirSync(playerAgentsDir)) {
              if (existsSync(join(playerAgentsDir, npcId, "relationship.json"))) {
                return true;
              }
            }
          } catch {
            // ignore read errors
          }
        }
      }
    } catch {
      // ignore read errors
    }
  }

  return false;
}
