/**
 * Per-NPC relationship store — tracks trust, familiarity, observations,
 * and anchor state per player-NPC pair against the world.db `relationships` table.
 *
 * Trust is stored as a scaled integer (trust * 10000) to preserve 4 decimal places
 * while using an INTEGER column. Complex fields (observations, anchor state) are
 * stored in extras_json.
 *
 * Spec: 2026-04-15-world-scope-refactor-design.md
 */

import type Database from "better-sqlite3";
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

export interface RelationshipResponse {
  trust: number;
  familiarity: number;
  disposition: string;
  observations: Observation[];
  anchor: AnchorState | null;
}

// Internal shape stored in the DB row
interface RelationshipExtras {
  familiarity: number;
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

const TRUST_SCALE = 10000;

function toScaled(trust: number): number {
  return Math.round(trust * TRUST_SCALE);
}

function fromScaled(scaled: number): number {
  return scaled / TRUST_SCALE;
}

export class RelationshipStore {
  private readonly db: Database.Database;

  private readonly stmtUpsert: Database.Statement;
  private readonly stmtGet: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    this.stmtUpsert = db.prepare(`
      INSERT INTO relationships
        (player_id, npc_id, trust, anchor_depth, anchor_type, last_trust_update, extras_json)
      VALUES
        (@player_id, @npc_id, @trust, @anchor_depth, @anchor_type, @now, @extras_json)
      ON CONFLICT(player_id, npc_id) DO UPDATE SET
        trust = excluded.trust,
        anchor_depth = excluded.anchor_depth,
        anchor_type = excluded.anchor_type,
        last_trust_update = excluded.last_trust_update,
        extras_json = excluded.extras_json
    `);

    this.stmtGet = db.prepare(`
      SELECT * FROM relationships WHERE player_id = ? AND npc_id = ?
    `);
  }

  /**
   * Compute first-contact trust from NPC profile + player character card.
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

  /** Get relationship state with decay applied at read time. */
  get(
    playerId: string,
    npcId: string,
    profile: NpcProfile | null,
    character: CharacterCard
  ): RelationshipResponse {
    const row = this.stmtGet.get(playerId, npcId) as Record<string, unknown> | undefined;

    if (row) {
      const extras = JSON.parse(row.extras_json as string) as RelationshipExtras;
      const trust = fromScaled(row.trust as number);
      const lastTrustUpdate = row.last_trust_update as number;
      const decayProf = resolveProfile(profile?.decayProfile, profile?.decayConfig);
      const daysSince = (Date.now() - lastTrustUpdate) / 86_400_000;

      const restingTrust = extras.anchor
        ? extras.anchor.anchorTrust
        : this.computeFirstContactTrust(profile, character);

      const effectiveTrust = trustDecay(trust, restingTrust, daysSince, decayProf);

      return {
        trust: Math.round(effectiveTrust * 1000) / 1000,
        familiarity: extras.familiarity,
        disposition: trustToDisposition(effectiveTrust),
        observations: extras.observations,
        anchor: extras.anchor,
      };
    }

    // First contact
    const trust = this.computeFirstContactTrust(profile, character);
    return {
      trust,
      familiarity: 0,
      disposition: trustToDisposition(trust),
      observations: [],
      anchor: null,
    };
  }

  /** Add an observation. Creates the row if it doesn't exist. */
  addObservation(
    playerId: string,
    npcId: string,
    observation: Observation,
    profile: NpcProfile | null,
    character: CharacterCard,
    anchorOutcome?: AnchorOutcome
  ): { trust: number; disposition: string; delta: { trust: number }; anchor: AnchorState | null } {
    const row = this.stmtGet.get(playerId, npcId) as Record<string, unknown> | undefined;

    let trust: number;
    let extras: RelationshipExtras;

    if (row) {
      trust = fromScaled(row.trust as number);
      extras = JSON.parse(row.extras_json as string) as RelationshipExtras;
    } else {
      trust = this.computeFirstContactTrust(profile, character);
      extras = { familiarity: 0, observations: [], anchor: null };
    }

    // Amplify delta if anchored
    let effectiveDelta = observation.delta.trust;
    if (extras.anchor) {
      effectiveDelta = amplifyDelta(effectiveDelta, extras.anchor.depth);
    }

    trust = clampTrust(trust + effectiveDelta);
    extras.familiarity += 1;

    extras.observations.push({
      ...observation,
      delta: { trust: effectiveDelta },
    });

    const anchorCfg = profile?.anchorConfig ?? DEFAULT_ANCHOR_CONFIG;

    // Anchor break check
    if (anchorOutcome?.shouldBreak && trust < -anchorCfg.rivalThreshold) {
      if (extras.anchor?.state === "friend") {
        extras.anchor = {
          state: "rival",
          depth: extras.anchor.depth,
          anchorTrust: trust,
          since: Date.now(),
        };
      } else if (!extras.anchor) {
        extras.anchor = {
          state: "rival",
          depth: anchorCfg.depthIncrement,
          anchorTrust: trust,
          since: Date.now(),
        };
      }
    }
    // Anchor promote check
    else if (
      anchorOutcome?.shouldPromote &&
      extras.familiarity >= anchorCfg.familiarityThreshold &&
      (!extras.anchor || extras.anchor.state !== "rival")
    ) {
      const newDepth = Math.max(
        extras.anchor?.depth ?? 0,
        anchorOutcome.minAnchorDepth || anchorCfg.depthIncrement
      );
      extras.anchor = {
        state: "friend",
        depth: Math.min(newDepth, 1.0),
        anchorTrust: trust,
        since: extras.anchor?.since ?? Date.now(),
      };
    }

    // Passive depth accrual
    if (
      extras.anchor &&
      extras.familiarity > anchorCfg.familiarityThreshold &&
      extras.anchor.depth < anchorCfg.passiveDepthCeiling
    ) {
      extras.anchor.depth = Math.min(
        extras.anchor.depth + anchorCfg.passiveDepthRate,
        anchorCfg.passiveDepthCeiling
      );
    }

    this.stmtUpsert.run({
      player_id: playerId,
      npc_id: npcId,
      trust: toScaled(trust),
      anchor_depth: extras.anchor ? Math.round(extras.anchor.depth * 10000) : 0,
      anchor_type: extras.anchor ? extras.anchor.state : null,
      now: Date.now(),
      extras_json: JSON.stringify(extras),
    });

    return {
      trust,
      disposition: trustToDisposition(trust),
      delta: { trust: effectiveDelta },
      anchor: extras.anchor,
    };
  }

  /** Explicitly set or reset anchor state. */
  setAnchor(
    playerId: string,
    npcId: string,
    state: "friend" | "rival" | "none",
    depth: number,
    profile: NpcProfile | null,
    character: CharacterCard
  ): RelationshipResponse {
    const row = this.stmtGet.get(playerId, npcId) as Record<string, unknown> | undefined;

    let trust: number;
    let extras: RelationshipExtras;

    if (row) {
      trust = fromScaled(row.trust as number);
      extras = JSON.parse(row.extras_json as string) as RelationshipExtras;
    } else {
      trust = this.computeFirstContactTrust(profile, character);
      extras = { familiarity: 0, observations: [], anchor: null };
    }

    if (state === "none") {
      extras.anchor = null;
    } else {
      extras.anchor = {
        state,
        depth: Math.max(0, Math.min(depth, 1.0)),
        anchorTrust: trust,
        since: Date.now(),
      };
    }

    this.stmtUpsert.run({
      player_id: playerId,
      npc_id: npcId,
      trust: toScaled(trust),
      anchor_depth: extras.anchor ? Math.round(extras.anchor.depth * 10000) : 0,
      anchor_type: extras.anchor ? extras.anchor.state : null,
      now: Date.now(),
      extras_json: JSON.stringify(extras),
    });

    return this.get(playerId, npcId, profile, character);
  }
}
