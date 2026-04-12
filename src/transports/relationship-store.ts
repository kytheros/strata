/**
 * Per-NPC relationship store — tracks trust, observations, and
 * disposition per player-NPC pair.
 *
 * File created on first observation. Before that, GET returns a
 * computed first-contact state from NPC defaultTrust + factionBias
 * matched against the player's character card.
 *
 * Spec: Section 1 (Per-NPC Relationship + First-contact behavior).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clampTrust, trustToDisposition } from "./tag-rule-engine.js";
import type { NpcProfile } from "./npc-profile-store.js";
import type { CharacterCard } from "./character-store.js";

export interface Observation {
  event: string;
  timestamp: number;
  tags: string[];
  delta: { trust: number };
  source: "manual" | "tag-rule" | "llm-extracted";
}

export interface RelationshipFile {
  trust: number;
  familiarity: number;
  observations: Observation[];
}

export interface RelationshipResponse {
  trust: number;
  familiarity: number;
  disposition: string;
  observations: Observation[];
}

export class RelationshipStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private filePath(playerId: string, npcId: string): string {
    return join(this.baseDir, "players", playerId, "agents", npcId, "relationship.json");
  }

  /** Read the raw relationship file. Returns null if no file exists. */
  private readFile(playerId: string, npcId: string): RelationshipFile | null {
    const path = this.filePath(playerId, npcId);
    if (!existsSync(path)) return null;
    try {
      const raw = readFileSync(path, "utf-8");
      return JSON.parse(raw) as RelationshipFile;
    } catch {
      return null;
    }
  }

  /** Write the relationship file atomically. */
  private writeFile(playerId: string, npcId: string, data: RelationshipFile): void {
    const path = this.filePath(playerId, npcId);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmp, path);
  }

  /**
   * Compute first-contact trust from NPC profile + player character card.
   * initialTrust = clamp(defaultTrust + sum(matched factionBiases))
   */
  computeFirstContactTrust(
    profile: NpcProfile | null,
    character: CharacterCard
  ): number {
    if (!profile) return 0;
    const defaultTrust = profile.defaultTrust ?? 0;
    const allPlayerTags = [...character.factions, ...character.tags];
    let biasSum = 0;
    for (const tag of allPlayerTags) {
      if (tag in profile.factionBias) {
        biasSum += profile.factionBias[tag];
      }
    }
    return clampTrust(defaultTrust + biasSum);
  }

  /**
   * Get the relationship state. If no file exists, computes first-contact
   * from the NPC profile and player character card.
   */
  get(
    playerId: string,
    npcId: string,
    profile: NpcProfile | null,
    character: CharacterCard
  ): RelationshipResponse {
    const file = this.readFile(playerId, npcId);
    if (file) {
      return {
        trust: file.trust,
        familiarity: file.familiarity,
        disposition: trustToDisposition(file.trust),
        observations: file.observations,
      };
    }
    // First contact — compute from profile + character card
    const trust = this.computeFirstContactTrust(profile, character);
    return {
      trust,
      familiarity: 0,
      disposition: trustToDisposition(trust),
      observations: [],
    };
  }

  /**
   * Add an observation. Creates the relationship file if it doesn't exist.
   * Returns the new trust and disposition.
   */
  addObservation(
    playerId: string,
    npcId: string,
    observation: Observation,
    profile: NpcProfile | null,
    character: CharacterCard
  ): { trust: number; disposition: string; delta: { trust: number } } {
    let file = this.readFile(playerId, npcId);
    if (!file) {
      // First observation — initialize from first-contact trust
      const initialTrust = this.computeFirstContactTrust(profile, character);
      file = { trust: initialTrust, familiarity: 0, observations: [] };
    }

    file.trust = clampTrust(file.trust + observation.delta.trust);
    file.familiarity += 1;
    file.observations.push(observation);
    this.writeFile(playerId, npcId, file);

    return {
      trust: file.trust,
      disposition: trustToDisposition(file.trust),
      delta: observation.delta,
    };
  }
}
