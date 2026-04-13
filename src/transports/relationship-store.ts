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
import type { AnchorOutcome } from "./tag-rule-engine.js";
import type { NpcProfile } from "./npc-profile-store.js";
import type { CharacterCard } from "./character-store.js";
import { resolveProfile, trustDecay, amplifyDelta } from "./decay-engine.js";

export interface Observation {
  event: string;
  timestamp: number;
  tags: string[];
  delta: { trust: number };
  source: "manual" | "tag-rule" | "llm-extracted";
}

export interface AnchorState {
  state: "friend" | "rival";
  depth: number;
  anchorTrust: number;
  since: number;
}

export interface RelationshipFile {
  trust: number;
  familiarity: number;
  observations: Observation[];
  anchor?: AnchorState | null;
  lastInteraction?: number;
}

export interface RelationshipResponse {
  trust: number;
  familiarity: number;
  disposition: string;
  observations: Observation[];
  anchor: AnchorState | null;
}

const DEFAULT_ANCHOR_CONFIG = {
  familiarityThreshold: 20,
  rivalThreshold: 0.3,
  depthIncrement: 0.15,
  passiveDepthCeiling: 0.3,
  passiveDepthRate: 0.01,
};

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
   * Trust decay is applied at read time based on the NPC's decay profile.
   */
  get(
    playerId: string,
    npcId: string,
    profile: NpcProfile | null,
    character: CharacterCard
  ): RelationshipResponse {
    const file = this.readFile(playerId, npcId);
    if (file) {
      const decayProf = resolveProfile(profile?.decayProfile, profile?.decayConfig);
      const lastInteraction = file.lastInteraction ?? Date.now();
      const daysSince = (Date.now() - lastInteraction) / 86_400_000;

      // Resting trust: anchor trust if anchored, first-contact trust otherwise
      const restingTrust = file.anchor
        ? file.anchor.anchorTrust
        : this.computeFirstContactTrust(profile, character);

      const effectiveTrust = trustDecay(file.trust, restingTrust, daysSince, decayProf);

      return {
        trust: Math.round(effectiveTrust * 1000) / 1000,
        familiarity: file.familiarity,
        disposition: trustToDisposition(effectiveTrust),
        observations: file.observations,
        anchor: file.anchor ?? null,
      };
    }
    // First contact — compute from profile + character card
    const trust = this.computeFirstContactTrust(profile, character);
    return {
      trust,
      familiarity: 0,
      disposition: trustToDisposition(trust),
      observations: [],
      anchor: null,
    };
  }

  /**
   * Add an observation. Creates the relationship file if it doesn't exist.
   * Returns the new trust, disposition, delta, and anchor state.
   * When anchorOutcome is provided, processes anchor promotion/breaking.
   */
  addObservation(
    playerId: string,
    npcId: string,
    observation: Observation,
    profile: NpcProfile | null,
    character: CharacterCard,
    anchorOutcome?: AnchorOutcome
  ): { trust: number; disposition: string; delta: { trust: number }; anchor: AnchorState | null } {
    let file = this.readFile(playerId, npcId);
    if (!file) {
      // First observation — initialize from first-contact trust
      const initialTrust = this.computeFirstContactTrust(profile, character);
      file = { trust: initialTrust, familiarity: 0, observations: [] };
    }

    // Amplify delta if anchored
    let effectiveDelta = observation.delta.trust;
    if (file.anchor) {
      effectiveDelta = amplifyDelta(effectiveDelta, file.anchor.depth);
    }

    file.trust = clampTrust(file.trust + effectiveDelta);
    file.familiarity += 1;
    file.lastInteraction = Date.now();
    file.observations.push({
      ...observation,
      delta: { trust: effectiveDelta },
    });

    const anchorCfg = profile?.anchorConfig ?? DEFAULT_ANCHOR_CONFIG;

    // Anchor break check (before promote — break takes priority)
    if (anchorOutcome?.shouldBreak && file.trust < -anchorCfg.rivalThreshold) {
      if (file.anchor?.state === "friend") {
        // Friend -> rival flip (depth preserved)
        file.anchor = {
          state: "rival",
          depth: file.anchor.depth,
          anchorTrust: file.trust,
          since: Date.now(),
        };
      } else if (!file.anchor) {
        // Direct to rival (no prior anchor)
        file.anchor = {
          state: "rival",
          depth: anchorCfg.depthIncrement,
          anchorTrust: file.trust,
          since: Date.now(),
        };
      }
    }
    // Anchor promote check
    else if (
      anchorOutcome?.shouldPromote &&
      file.familiarity >= anchorCfg.familiarityThreshold &&
      (!file.anchor || file.anchor.state !== "rival") // don't promote if already rival
    ) {
      const newDepth = Math.max(
        file.anchor?.depth ?? 0,
        anchorOutcome.minAnchorDepth || anchorCfg.depthIncrement
      );
      file.anchor = {
        state: "friend",
        depth: Math.min(newDepth, 1.0),
        anchorTrust: file.trust,
        since: file.anchor?.since ?? Date.now(),
      };
    }

    // Passive depth accrual (if anchored and below ceiling)
    if (
      file.anchor &&
      file.familiarity > anchorCfg.familiarityThreshold &&
      file.anchor.depth < anchorCfg.passiveDepthCeiling
    ) {
      file.anchor.depth = Math.min(
        file.anchor.depth + anchorCfg.passiveDepthRate,
        anchorCfg.passiveDepthCeiling
      );
    }

    this.writeFile(playerId, npcId, file);

    return {
      trust: file.trust,
      disposition: trustToDisposition(file.trust),
      delta: { trust: effectiveDelta },
      anchor: file.anchor ?? null,
    };
  }

  /**
   * Explicitly set or reset anchor state for a player-NPC relationship.
   * Used for declaring family bonds at game start, breaking anchors via
   * game mechanics, and debug tooling.
   */
  setAnchor(
    playerId: string,
    npcId: string,
    state: "friend" | "rival" | "none",
    depth: number,
    profile: NpcProfile | null,
    character: CharacterCard
  ): RelationshipResponse {
    let file = this.readFile(playerId, npcId);
    if (!file) {
      const initialTrust = this.computeFirstContactTrust(profile, character);
      file = { trust: initialTrust, familiarity: 0, observations: [] };
    }

    if (state === "none") {
      file.anchor = null;
    } else {
      file.anchor = {
        state,
        depth: Math.max(0, Math.min(depth, 1.0)),
        anchorTrust: file.trust,
        since: Date.now(),
      };
    }

    this.writeFile(playerId, npcId, file);
    return this.get(playerId, npcId, profile, character);
  }
}
