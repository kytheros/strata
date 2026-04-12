/**
 * Player character card store — read/write visible player identity at
 * {baseDir}/players/{playerId}/character.json.
 *
 * Spec: Section 1 (Player Character Card).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface CharacterCard {
  displayName: string;
  factions: string[];
  tags: string[];
}

export class CharacterStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private cardPath(playerId: string): string {
    return join(this.baseDir, "players", playerId, "character.json");
  }

  /** Read a character card. Returns default card if not found. */
  read(playerId: string): CharacterCard {
    const path = this.cardPath(playerId);
    if (!existsSync(path)) {
      return { displayName: "", factions: [], tags: [] };
    }
    try {
      const raw = readFileSync(path, "utf-8");
      const data = JSON.parse(raw) as Partial<CharacterCard>;
      return {
        displayName: data.displayName ?? "",
        factions: Array.isArray(data.factions) ? data.factions : [],
        tags: Array.isArray(data.tags) ? data.tags : [],
      };
    } catch {
      return { displayName: "", factions: [], tags: [] };
    }
  }

  /** Write a character card. */
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

    const path = this.cardPath(playerId);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(card, null, 2), "utf-8");
    renameSync(tmp, path);
    return card;
  }
}
