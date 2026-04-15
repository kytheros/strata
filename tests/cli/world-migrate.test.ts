/**
 * Tests for `strata world-migrate` — migrates the legacy FS-tree layout
 * (agents/{npcId}/profile.json, players/{playerId}/…) into the world-scoped
 * SQLite schema (worlds/default/world.db).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { worldMigrate } from "../../src/cli/world-migrate.js";
import { WorldRegistry } from "../../src/transports/world-registry.js";

// ── helpers ────────────────────────────────────────────────────────────────

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "strata-world-migrate-"));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

/** Seed a minimal legacy layout. */
function seedLegacyTree(opts: {
  npcIds?: string[];
  playerIds?: string[];
  memories?: Record<string, string[]>; // npcId → content[] (stored in first player)
  relationships?: Record<string, Record<string, { trust: number }>>; // playerId → npcId → data
}) {
  const {
    npcIds = ["goran-blacksmith"],
    playerIds = ["default"],
    memories = {},
    relationships = {},
  } = opts;

  // agents/{npcId}/profile.json
  const agentsDir = join(baseDir, "agents");
  for (const npcId of npcIds) {
    const npcDir = join(agentsDir, npcId);
    mkdirSync(npcDir, { recursive: true });
    writeFileSync(join(npcDir, "profile.json"), JSON.stringify({
      name: npcId.replace(/-/g, " "),
      alignment: { ethical: "lawful", moral: "good" },
      defaultTrust: 0.1,
      factionBias: {},
      gossipTrait: "normal",
      traits: ["honest"],
      backstory: `Backstory for ${npcId}`,
    }));
  }

  // players/{playerId}/character.json + agents/{npcId}/strata.db + relationship.json
  const playersDir = join(baseDir, "players");
  for (const playerId of playerIds) {
    const playerDir = join(playersDir, playerId);
    mkdirSync(playerDir, { recursive: true });
    writeFileSync(join(playerDir, "character.json"), JSON.stringify({
      displayName: playerId,
      factions: ["merchants"],
      tags: ["human"],
    }));

    const playerAgentsDir = join(playerDir, "agents");
    for (const npcId of npcIds) {
      const paNpcDir = join(playerAgentsDir, npcId);
      mkdirSync(paNpcDir, { recursive: true });

      // Legacy strata.db (per-player-npc KnowledgeStore SQLite)
      const memContents = memories[npcId] ?? [];
      const legacyDb = new Database(join(paNpcDir, "strata.db"));
      legacyDb.exec(`
        CREATE TABLE IF NOT EXISTS knowledge (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL DEFAULT 'fact',
          project TEXT NOT NULL DEFAULT '',
          session_id TEXT NOT NULL DEFAULT '',
          timestamp INTEGER NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          details TEXT NOT NULL DEFAULT '',
          tags TEXT NOT NULL DEFAULT '[]',
          related_files TEXT NOT NULL DEFAULT '[]',
          tool TEXT NOT NULL DEFAULT ''
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts
          USING fts5(summary, details, tags, content='knowledge', content_rowid='rowid');
      `);
      const insertStmt = legacyDb.prepare(`
        INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, details, tags, related_files, tool)
        VALUES (?, 'episodic', ?, 'sess-1', ?, ?, '', '[]', '[]', '')
      `);
      for (const content of memContents) {
        insertStmt.run(
          `mem-${npcId}-${content.slice(0, 8).replace(/\s/g, "_")}`,
          npcId,
          Date.now(),
          content
        );
      }
      legacyDb.close();

      // relationship.json
      const relData = relationships[playerId]?.[npcId];
      if (relData) {
        writeFileSync(join(paNpcDir, "relationship.json"), JSON.stringify({
          trust: relData.trust,
          familiarity: 3,
          observations: [{ event: "met", timestamp: Date.now(), tags: [], delta: { trust: 0.1 }, source: "manual" }],
          anchor: null,
        }));
      } else {
        writeFileSync(join(paNpcDir, "relationship.json"), JSON.stringify({
          trust: 0.1,
          familiarity: 0,
          observations: [],
          anchor: null,
        }));
      }
    }
  }
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("worldMigrate — no-op on empty dir", () => {
  it("returns migrated=false when no legacy layout present", () => {
    const result = worldMigrate({ basePath: baseDir });
    expect(result.migrated).toBe(false);
    expect(result.summary).toContain("No legacy layout");
  });

  it("returns migrated=false when worlds/ dir exists (already migrated)", () => {
    mkdirSync(join(baseDir, "worlds"), { recursive: true });
    const result = worldMigrate({ basePath: baseDir });
    expect(result.migrated).toBe(false);
  });
});

describe("worldMigrate — profile migration", () => {
  it("migrates NPC profile from agents/{npcId}/profile.json to npc_profiles", () => {
    seedLegacyTree({ npcIds: ["goran-blacksmith"], playerIds: ["default"] });
    const result = worldMigrate({ basePath: baseDir });
    expect(result.migrated).toBe(true);

    const db = new Database(join(baseDir, "worlds", "default", "world.db"));
    const row = db.prepare("SELECT * FROM npc_profiles WHERE npc_id = ?").get("goran-blacksmith") as Record<string, unknown> | undefined;
    db.close();
    expect(row).toBeDefined();
    expect(row!.name).toBe("goran blacksmith");
  });

  it("migrates multiple NPC profiles", () => {
    seedLegacyTree({ npcIds: ["goran-blacksmith", "brynn-herbalist"], playerIds: ["default"] });
    worldMigrate({ basePath: baseDir });

    const db = new Database(join(baseDir, "worlds", "default", "world.db"));
    const rows = db.prepare("SELECT npc_id FROM npc_profiles").all() as { npc_id: string }[];
    db.close();
    expect(rows.map(r => r.npc_id)).toContain("goran-blacksmith");
    expect(rows.map(r => r.npc_id)).toContain("brynn-herbalist");
  });
});

describe("worldMigrate — character migration", () => {
  it("migrates player character from players/{id}/character.json to player_characters", () => {
    seedLegacyTree({ npcIds: ["goran-blacksmith"], playerIds: ["default"] });
    worldMigrate({ basePath: baseDir });

    const db = new Database(join(baseDir, "worlds", "default", "world.db"));
    const row = db.prepare("SELECT * FROM player_characters WHERE player_id = ?").get("default") as Record<string, unknown> | undefined;
    db.close();
    expect(row).toBeDefined();
    expect(row!.name).toBe("default");
  });
});

describe("worldMigrate — relationship migration", () => {
  it("migrates relationship data into the relationships table", () => {
    seedLegacyTree({
      npcIds: ["goran-blacksmith"],
      playerIds: ["default"],
      relationships: { default: { "goran-blacksmith": { trust: 0.5 } } },
    });
    worldMigrate({ basePath: baseDir });

    const db = new Database(join(baseDir, "worlds", "default", "world.db"));
    const row = db.prepare(
      "SELECT * FROM relationships WHERE player_id = ? AND npc_id = ?"
    ).get("default", "goran-blacksmith") as Record<string, unknown> | undefined;
    db.close();
    expect(row).toBeDefined();
    // trust stored as scaled int (trust * 10000)
    expect(row!.trust).toBe(5000);
  });
});

describe("worldMigrate — memory migration", () => {
  it("migrates memories from per-(player,npc) strata.db into npc_memories", () => {
    seedLegacyTree({
      npcIds: ["goran-blacksmith"],
      playerIds: ["default"],
      memories: { "goran-blacksmith": ["player saved my daughter", "player likes swords"] },
    });
    worldMigrate({ basePath: baseDir });

    const db = new Database(join(baseDir, "worlds", "default", "world.db"));
    const rows = db.prepare(
      "SELECT * FROM npc_memories WHERE npc_id = ?"
    ).all("goran-blacksmith") as { content: string }[];
    db.close();
    expect(rows.length).toBe(2);
    const contents = rows.map(r => r.content);
    expect(contents).toContain("player saved my daughter");
    expect(contents).toContain("player likes swords");
  });

  it("deduplicates memories across multiple players for the same NPC", () => {
    seedLegacyTree({
      npcIds: ["goran-blacksmith"],
      playerIds: ["alice", "bob"],
      memories: {
        // both players have the same memory about goran
        "goran-blacksmith": ["player saved my daughter"],
      },
    });
    worldMigrate({ basePath: baseDir });

    const db = new Database(join(baseDir, "worlds", "default", "world.db"));
    const rows = db.prepare(
      "SELECT * FROM npc_memories WHERE npc_id = ?"
    ).all("goran-blacksmith") as { content: string }[];
    db.close();
    // Should be deduped to 1 (same content from both players)
    expect(rows.length).toBe(1);
    expect(rows[0].content).toBe("player saved my daughter");
  });

  it("keeps distinct memories across players for the same NPC", () => {
    // seed manually: two players, different memories on same NPC
    const agentsDir = join(baseDir, "agents", "goran-blacksmith");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "profile.json"), JSON.stringify({
      name: "Goran",
      alignment: { ethical: "lawful", moral: "good" },
      defaultTrust: 0,
      factionBias: {},
      gossipTrait: "normal",
      traits: [],
      backstory: "",
    }));

    for (const [playerId, content] of [["alice", "alice helped forge a sword"], ["bob", "bob bought armor"]] as [string, string][]) {
      const dir = join(baseDir, "players", playerId, "agents", "goran-blacksmith");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "relationship.json"), JSON.stringify({ trust: 0, familiarity: 0, observations: [], anchor: null }));
      const db = new Database(join(dir, "strata.db"));
      db.exec(`CREATE TABLE IF NOT EXISTS knowledge (id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'fact', project TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL DEFAULT '', timestamp INTEGER NOT NULL, summary TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', related_files TEXT NOT NULL DEFAULT '[]', tool TEXT NOT NULL DEFAULT '')`);
      db.prepare("INSERT INTO knowledge (id, type, project, session_id, timestamp, summary, tags, related_files, tool) VALUES (?,?,?,?,?,?,?,?,?)").run(`mem-${playerId}`, "episodic", "goran-blacksmith", "sess", Date.now(), content, "[]", "[]", "");
      db.close();
      const playerDir = join(baseDir, "players", playerId);
      writeFileSync(join(playerDir, "character.json"), JSON.stringify({ displayName: playerId, factions: [], tags: [] }));
    }

    worldMigrate({ basePath: baseDir });

    const db = new Database(join(baseDir, "worlds", "default", "world.db"));
    const rows = db.prepare("SELECT content FROM npc_memories WHERE npc_id = ?").all("goran-blacksmith") as { content: string }[];
    db.close();
    expect(rows.length).toBe(2);
    expect(rows.map(r => r.content)).toContain("alice helped forge a sword");
    expect(rows.map(r => r.content)).toContain("bob bought armor");
  });
});

describe("worldMigrate — registry + world.db", () => {
  it("creates worlds/default/world.db", () => {
    seedLegacyTree({});
    worldMigrate({ basePath: baseDir });
    expect(existsSync(join(baseDir, "worlds", "default", "world.db"))).toBe(true);
  });

  it("registers 'default' world in registry/worlds.json", () => {
    seedLegacyTree({});
    worldMigrate({ basePath: baseDir });
    const reg = new WorldRegistry(baseDir);
    expect(reg.get("default")).not.toBeNull();
  });
});

describe("worldMigrate — legacy backup", () => {
  it("renames agents/ to .legacy-backup-agents-{ts}", () => {
    seedLegacyTree({});
    worldMigrate({ basePath: baseDir });
    expect(existsSync(join(baseDir, "agents"))).toBe(false);
    const entries = readdirSync(baseDir);
    expect(entries.some(e => e.startsWith(".legacy-backup-agents-"))).toBe(true);
  });

  it("renames players/ to .legacy-backup-players-{ts}", () => {
    seedLegacyTree({});
    worldMigrate({ basePath: baseDir });
    expect(existsSync(join(baseDir, "players"))).toBe(false);
  });

  it("summary reports correct counts", () => {
    seedLegacyTree({
      npcIds: ["goran-blacksmith"],
      playerIds: ["default"],
      memories: { "goran-blacksmith": ["memory one", "memory two"] },
    });
    const result = worldMigrate({ basePath: baseDir });
    expect(result.summary).toContain("1 profile");
    expect(result.summary).toContain("1 character");
    expect(result.summary).toContain("2 memor");
  });
});
