/**
 * `strata world-migrate`
 *
 * Migrates the legacy FS-tree layout into the world-scoped SQLite schema.
 *
 * Legacy layout:
 *   {basePath}/agents/{npcId}/profile.json
 *   {basePath}/players/{playerId}/character.json
 *   {basePath}/players/{playerId}/agents/{npcId}/strata.db
 *   {basePath}/players/{playerId}/agents/{npcId}/relationship.json
 *
 * Target layout:
 *   {basePath}/worlds/default/world.db   (npc_profiles, player_characters,
 *                                         relationships, npc_memories)
 *   {basePath}/registry/worlds.json
 *
 * After migration the legacy directories are renamed to
 *   {basePath}/.legacy-backup-agents-{timestamp}
 *   {basePath}/.legacy-backup-players-{timestamp}
 *
 * Memories are merged per-NPC across all players and deduplicated by
 * SHA-256(content) to avoid duplication when multiple players shared the
 * same interaction with an NPC.
 *
 * Spec: 2026-04-15-world-scope-refactor-plan.md Task 12.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { WorldPool } from "../transports/world-pool.js";
import { WorldRegistry } from "../transports/world-registry.js";

export interface MigrateOptions {
  basePath: string;
}

export interface MigrateResult {
  migrated: boolean;
  summary: string;
}

/**
 * Content-hash used for memory deduplication.
 * Two memories are considered identical if their trimmed text content hashes
 * the same — regardless of which player saw them.
 */
function contentHash(content: string): string {
  return createHash("sha256").update(content.trim()).digest("hex");
}

export function worldMigrate(opts: MigrateOptions): MigrateResult {
  const { basePath } = opts;

  const agentsDir = join(basePath, "agents");
  const playersDir = join(basePath, "players");
  const worldsDir = join(basePath, "worlds");

  // ── Guard: already migrated or nothing to migrate ──────────────────────
  if (existsSync(worldsDir)) {
    return { migrated: false, summary: "No legacy layout detected (worlds/ already exists)." };
  }
  const hasLegacy = existsSync(agentsDir) || existsSync(playersDir);
  if (!hasLegacy) {
    return { migrated: false, summary: "No legacy layout detected." };
  }

  // ── Prepare world DB ───────────────────────────────────────────────────
  const registry = new WorldRegistry(basePath);
  if (!registry.get("default")) {
    registry.create("default", "Default World");
  }
  const pool = new WorldPool(basePath, 4);
  const db = pool.open("default");
  db.pragma("journal_mode = WAL");

  const stats = { profiles: 0, characters: 0, relationships: 0, memories: 0 };

  // ── 1. NPC profiles ────────────────────────────────────────────────────
  if (existsSync(agentsDir)) {
    for (const npcId of readdirSync(agentsDir)) {
      const profilePath = join(agentsDir, npcId, "profile.json");
      if (!existsSync(profilePath)) continue;
      try {
        const p = JSON.parse(readFileSync(profilePath, "utf8")) as Record<string, unknown>;
        insertProfile(db, npcId, p);
        stats.profiles++;
      } catch {
        // skip malformed profiles
      }
    }
  }

  // ── 2. Players (character + relationships + memories) ──────────────────
  // Memories are merged per-NPC across all players; dedup by content hash.
  // Map key: npcId → Set of seen content hashes.
  const seenByNpc = new Map<string, Set<string>>();

  if (existsSync(playersDir)) {
    for (const playerId of readdirSync(playersDir)) {
      const playerDir = join(playersDir, playerId);
      if (!existsSync(join(playerDir, "character.json"))) continue;

      // Character card
      try {
        const c = JSON.parse(readFileSync(join(playerDir, "character.json"), "utf8")) as Record<string, unknown>;
        insertCharacter(db, playerId, c);
        stats.characters++;
      } catch {
        // skip malformed character cards
      }

      // Per-NPC: relationship + memories
      const playerAgentsDir = join(playerDir, "agents");
      if (!existsSync(playerAgentsDir)) continue;

      for (const npcId of readdirSync(playerAgentsDir)) {
        const npcDir = join(playerAgentsDir, npcId);

        // Relationship
        const relPath = join(npcDir, "relationship.json");
        if (existsSync(relPath)) {
          try {
            const r = JSON.parse(readFileSync(relPath, "utf8")) as Record<string, unknown>;
            insertRelationship(db, playerId, npcId, r);
            stats.relationships++;
          } catch {
            // skip malformed relationship data
          }
        }

        // Memories from legacy per-(player,npc) strata.db
        const legacyDbPath = join(npcDir, "strata.db");
        if (existsSync(legacyDbPath)) {
          if (!seenByNpc.has(npcId)) seenByNpc.set(npcId, new Set());
          const seenHashes = seenByNpc.get(npcId)!;
          stats.memories += importMemories(db, npcId, legacyDbPath, seenHashes);
        }
      }
    }
  }

  // ── 3. Rename legacy directories ───────────────────────────────────────
  pool.close();
  const stamp = Date.now();
  if (existsSync(agentsDir)) {
    renameSync(agentsDir, join(basePath, `.legacy-backup-agents-${stamp}`));
  }
  if (existsSync(playersDir)) {
    renameSync(playersDir, join(basePath, `.legacy-backup-players-${stamp}`));
  }

  const summary =
    `Migrated ${stats.profiles} profile${stats.profiles !== 1 ? "s" : ""}, ` +
    `${stats.characters} character${stats.characters !== 1 ? "s" : ""}, ` +
    `${stats.relationships} relationship${stats.relationships !== 1 ? "s" : ""}, ` +
    `${stats.memories} memor${stats.memories !== 1 ? "ies" : "y"} ` +
    `to worlds/default/world.db`;

  return { migrated: true, summary };
}

// ── insert helpers ─────────────────────────────────────────────────────────

const TRUST_SCALE = 10000;

function insertProfile(db: Database.Database, npcId: string, p: Record<string, unknown>): void {
  const alignment = (p.alignment as Record<string, string> | undefined) ?? {};
  const defaultTrust = typeof p.defaultTrust === "number" ? p.defaultTrust : 0;
  const factionBias = (p.factionBias as Record<string, number> | undefined) ?? {};
  const now = Date.now();

  db.prepare(`
    INSERT OR IGNORE INTO npc_profiles (
      npc_id, name, role,
      alignment_ethical, alignment_moral,
      default_trust, gossip_trait, decay_profile_name,
      factions_json, faction_biases_json,
      propagate_tags_json, tag_rules_json,
      decay_config_json, extras_json,
      created_at, updated_at
    ) VALUES (
      @npc_id, @name, @role,
      @alignment_ethical, @alignment_moral,
      @default_trust, @gossip_trait, @decay_profile_name,
      @factions_json, @faction_biases_json,
      @propagate_tags_json, @tag_rules_json,
      @decay_config_json, @extras_json,
      @now, @now
    )
  `).run({
    npc_id: npcId,
    name: typeof p.name === "string" ? p.name : npcId,
    role: typeof p.title === "string" ? p.title : null,
    alignment_ethical: alignment.ethical ?? "neutral",
    alignment_moral: alignment.moral ?? "neutral",
    default_trust: Math.round(defaultTrust * TRUST_SCALE),
    gossip_trait: typeof p.gossipTrait === "string" ? p.gossipTrait : "normal",
    decay_profile_name: typeof p.decayProfile === "string" ? p.decayProfile : "normal",
    factions_json: typeof p.faction === "string" ? JSON.stringify([p.faction]) : null,
    faction_biases_json: JSON.stringify(factionBias),
    propagate_tags_json: Array.isArray(p.propagateTags) ? JSON.stringify(p.propagateTags) : null,
    tag_rules_json: p.tagRules ? JSON.stringify(p.tagRules) : null,
    decay_config_json: p.decayConfig ? JSON.stringify(p.decayConfig) : null,
    extras_json: JSON.stringify({
      traits: Array.isArray(p.traits) ? p.traits : [],
      backstory: typeof p.backstory === "string" ? p.backstory : "",
      title: typeof p.title === "string" ? p.title : undefined,
      anchorConfig: p.anchorConfig,
    }),
    now,
  });
}

function insertCharacter(db: Database.Database, playerId: string, c: Record<string, unknown>): void {
  const now = Date.now();
  db.prepare(`
    INSERT OR IGNORE INTO player_characters
      (player_id, name, factions_json, extras_json, created_at, updated_at)
    VALUES
      (@player_id, @name, @factions_json, @extras_json, @now, @now)
  `).run({
    player_id: playerId,
    name: typeof c.displayName === "string" ? c.displayName : playerId,
    factions_json: Array.isArray(c.factions) ? JSON.stringify(c.factions) : "[]",
    extras_json: JSON.stringify({ tags: Array.isArray(c.tags) ? c.tags : [] }),
    now,
  });
}

function insertRelationship(db: Database.Database, playerId: string, npcId: string, r: Record<string, unknown>): void {
  const trust = typeof r.trust === "number" ? r.trust : 0;
  const familiarity = typeof r.familiarity === "number" ? r.familiarity : 0;
  const observations = Array.isArray(r.observations) ? r.observations : [];
  const anchor = r.anchor ?? null;

  db.prepare(`
    INSERT OR IGNORE INTO relationships
      (player_id, npc_id, trust, anchor_depth, anchor_type, last_trust_update, extras_json)
    VALUES
      (@player_id, @npc_id, @trust, @anchor_depth, @anchor_type, @now, @extras_json)
  `).run({
    player_id: playerId,
    npc_id: npcId,
    trust: Math.round(trust * TRUST_SCALE),
    anchor_depth: 0,
    anchor_type: null,
    now: Date.now(),
    extras_json: JSON.stringify({ familiarity, observations, anchor }),
  });
}

function importMemories(
  db: Database.Database,
  npcId: string,
  legacyDbPath: string,
  seenHashes: Set<string>
): number {
  let imported = 0;
  let legacyDb: Database.Database | null = null;
  try {
    legacyDb = new Database(legacyDbPath, { readonly: true });
    // Legacy schema has a `knowledge` table with `summary` as the memory text
    const rows = legacyDb.prepare(
      "SELECT * FROM knowledge ORDER BY timestamp ASC"
    ).all() as Record<string, unknown>[];

    const insertMemory = db.prepare(`
      INSERT INTO npc_memories
        (memory_id, npc_id, content, tags_json, importance, anchor_depth,
         created_at, last_accessed, access_count)
      VALUES
        (@memory_id, @npc_id, @content, @tags_json, @importance, 0,
         @created_at, @last_accessed, 0)
    `);

    for (const row of rows) {
      const content = (typeof row.summary === "string" ? row.summary : "").trim();
      if (!content) continue;
      const hash = contentHash(content);
      if (seenHashes.has(hash)) continue;
      seenHashes.add(hash);

      const tags = typeof row.tags === "string" ? row.tags : "[]";
      const ts = typeof row.timestamp === "number" ? row.timestamp : Date.now();

      insertMemory.run({
        memory_id: randomUUID(),
        npc_id: npcId,
        content,
        tags_json: tags,
        importance: 50,
        created_at: ts,
        last_accessed: ts,
      });
      imported++;
    }
  } catch {
    // skip unreadable legacy DBs
  } finally {
    try { legacyDb?.close(); } catch { /* ignore */ }
  }
  return imported;
}
