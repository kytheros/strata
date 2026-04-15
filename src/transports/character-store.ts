/**
 * Player character card store — read/write player character cards against
 * the world.db `player_characters` table.
 *
 * Hot fields (displayName, factions, tags) are per-PC.
 * Factions and tags are stored as JSON columns.
 *
 * Spec: 2026-04-15-world-scope-refactor-design.md
 */

import type Database from "better-sqlite3";

export interface CharacterCard {
  displayName: string;
  factions: string[];
  tags: string[];
}

export class CharacterStore {
  private readonly db: Database.Database;

  private readonly stmtUpsert: Database.Statement;
  private readonly stmtGet: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    this.stmtUpsert = db.prepare(`
      INSERT INTO player_characters
        (player_id, name, factions_json, extras_json, created_at, updated_at)
      VALUES
        (@player_id, @name, @factions_json, @extras_json, @now, @now)
      ON CONFLICT(player_id) DO UPDATE SET
        name = excluded.name,
        factions_json = excluded.factions_json,
        extras_json = excluded.extras_json,
        updated_at = excluded.updated_at
    `);

    this.stmtGet = db.prepare(`
      SELECT * FROM player_characters WHERE player_id = ?
    `);
  }

  /** Read a character card. Returns default card if not found. */
  read(playerId: string): CharacterCard {
    const row = this.stmtGet.get(playerId) as Record<string, unknown> | undefined;
    if (!row) {
      return { displayName: "", factions: [], tags: [] };
    }
    return this.rowToCard(row);
  }

  /** Write a character card. Returns the stored card. */
  write(playerId: string, input: Record<string, unknown>): CharacterCard {
    const card: CharacterCard = {
      displayName: typeof input.displayName === "string" ? input.displayName : "",
      factions: Array.isArray(input.factions)
        ? (input.factions as unknown[]).filter((f): f is string => typeof f === "string")
        : [],
      tags: Array.isArray(input.tags)
        ? (input.tags as unknown[]).filter((t): t is string => typeof t === "string")
        : [],
    };

    this.stmtUpsert.run({
      player_id: playerId,
      name: card.displayName,
      factions_json: JSON.stringify(card.factions),
      extras_json: JSON.stringify({ tags: card.tags }),
      now: Date.now(),
    });

    return card;
  }

  private rowToCard(row: Record<string, unknown>): CharacterCard {
    const factions = row.factions_json
      ? (JSON.parse(row.factions_json as string) as string[])
      : [];
    const extras = row.extras_json
      ? (JSON.parse(row.extras_json as string) as Record<string, unknown>)
      : {};
    const tags = Array.isArray(extras.tags) ? (extras.tags as string[]) : [];

    return {
      displayName: (row.name as string) ?? "",
      factions,
      tags,
    };
  }
}
