/**
 * NPC profile store — read/write shared NPC profiles at
 * {baseDir}/agents/{npcId}/profile.json.
 *
 * Profiles are shared across all players. Admin-write, player-read.
 * Atomic writes via temp-file + rename.
 *
 * Spec: Section 1 (NPC Profile).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface NpcAlignment {
  ethical: "lawful" | "neutral" | "chaotic";
  moral: "good" | "neutral" | "evil";
}

export interface NpcProfile {
  name: string;
  title?: string;
  alignment: NpcAlignment;
  faction?: string;
  traits: string[];
  backstory: string;
  defaultTrust: number;
  factionBias: Record<string, number>;
  tagRules?: Record<string, { trust: number }> | null;
}

const VALID_ETHICAL = new Set(["lawful", "neutral", "chaotic"]);
const VALID_MORAL = new Set(["good", "neutral", "evil"]);

export class NpcProfileStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private profilePath(npcId: string): string {
    return join(this.baseDir, "agents", npcId, "profile.json");
  }

  /** Read a profile. Returns null if not found. */
  read(npcId: string): NpcProfile | null {
    const path = this.profilePath(npcId);
    if (!existsSync(path)) return null;
    try {
      const raw = readFileSync(path, "utf-8");
      return JSON.parse(raw) as NpcProfile;
    } catch {
      return null;
    }
  }

  /** Write a profile. Validates and returns the stored profile. Throws on invalid input. */
  write(npcId: string, input: Record<string, unknown>): NpcProfile {
    const name = input.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("Missing required field: name");
    }

    const alignment = input.alignment as Record<string, unknown> | undefined;
    if (!alignment || !VALID_ETHICAL.has(String(alignment.ethical)) || !VALID_MORAL.has(String(alignment.moral))) {
      throw new Error(
        "Invalid alignment: ethical must be lawful|neutral|chaotic, moral must be good|neutral|evil"
      );
    }

    const defaultTrust = typeof input.defaultTrust === "number" ? input.defaultTrust : 0.0;
    if (defaultTrust < -1.0 || defaultTrust > 1.0) {
      throw new Error("defaultTrust must be between -1.0 and 1.0");
    }

    const factionBias: Record<string, number> = {};
    if (input.factionBias && typeof input.factionBias === "object") {
      for (const [key, val] of Object.entries(input.factionBias as Record<string, unknown>)) {
        if (typeof val !== "number") {
          throw new Error(`factionBias value for "${key}" must be a number`);
        }
        factionBias[key] = val;
      }
    }

    let tagRules: Record<string, { trust: number }> | null = null;
    if (input.tagRules && typeof input.tagRules === "object") {
      tagRules = {};
      for (const [key, val] of Object.entries(input.tagRules as Record<string, unknown>)) {
        const entry = val as Record<string, unknown>;
        if (typeof entry?.trust !== "number") {
          throw new Error(`tagRules entry for "${key}" must have a numeric trust field`);
        }
        tagRules[key] = { trust: entry.trust as number };
      }
    }

    const profile: NpcProfile = {
      name: String(name),
      title: typeof input.title === "string" ? input.title : undefined,
      alignment: {
        ethical: String(alignment.ethical) as NpcProfile["alignment"]["ethical"],
        moral: String(alignment.moral) as NpcProfile["alignment"]["moral"],
      },
      faction: typeof input.faction === "string" ? input.faction : undefined,
      traits: Array.isArray(input.traits)
        ? (input.traits as unknown[]).filter((t): t is string => typeof t === "string")
        : [],
      backstory: typeof input.backstory === "string" ? input.backstory : "",
      defaultTrust,
      factionBias,
      tagRules,
    };

    const path = this.profilePath(npcId);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(profile, null, 2), "utf-8");
    renameSync(tmp, path);
    return profile;
  }
}
