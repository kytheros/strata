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

export interface DecayConfig {
  lambdaBase: number;
  lambdaTrust: number;
  blendAlpha: number;
  dayEquivalent: number;
}

export interface AnchorConfig {
  familiarityThreshold: number;
  rivalThreshold: number;
  depthIncrement: number;
  passiveDepthCeiling: number;
  passiveDepthRate: number;
}

export type GossipTrait = "gossipy" | "discreet" | "normal";

export interface NpcProfile {
  name: string;
  title?: string;
  alignment: NpcAlignment;
  faction?: string;
  traits: string[];
  backstory: string;
  defaultTrust: number;
  factionBias: Record<string, number>;
  tagRules?: Record<string, { trust: number; promoteAnchor?: boolean; breakAnchor?: boolean; minAnchorDepth?: number }> | null;
  decayProfile?: "sharp" | "normal" | "fading" | "custom";
  decayConfig?: DecayConfig;
  anchorConfig?: AnchorConfig;
  propagateTags?: string[];
  gossipTrait: GossipTrait;
}

const VALID_ETHICAL = new Set(["lawful", "neutral", "chaotic"]);
const VALID_MORAL = new Set(["good", "neutral", "evil"]);
const VALID_DECAY_PROFILES = new Set(["sharp", "normal", "fading", "custom"]);
const VALID_GOSSIP_TRAITS = new Set(["gossipy", "discreet", "normal"]);

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
      const parsed = JSON.parse(raw) as NpcProfile;
      // Backfill gossipTrait default for older profiles stored before this field existed.
      if (parsed.gossipTrait === undefined) {
        parsed.gossipTrait = "normal";
      }
      return parsed;
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

    let tagRules: NpcProfile["tagRules"] = null;
    if (input.tagRules && typeof input.tagRules === "object") {
      tagRules = {};
      for (const [key, val] of Object.entries(input.tagRules as Record<string, unknown>)) {
        const entry = val as Record<string, unknown>;
        if (typeof entry?.trust !== "number") {
          throw new Error(`tagRules entry for "${key}" must have a numeric trust field`);
        }
        const rule: { trust: number; promoteAnchor?: boolean; breakAnchor?: boolean; minAnchorDepth?: number } = {
          trust: entry.trust as number,
        };
        if (typeof entry.promoteAnchor === "boolean") rule.promoteAnchor = entry.promoteAnchor;
        if (typeof entry.breakAnchor === "boolean") rule.breakAnchor = entry.breakAnchor;
        if (typeof entry.minAnchorDepth === "number") rule.minAnchorDepth = entry.minAnchorDepth;
        tagRules[key] = rule;
      }
    }

    // Decay profile
    let decayProfile: NpcProfile["decayProfile"];
    if (input.decayProfile !== undefined) {
      if (!VALID_DECAY_PROFILES.has(String(input.decayProfile))) {
        throw new Error("decayProfile must be sharp, normal, fading, or custom");
      }
      decayProfile = String(input.decayProfile) as NpcProfile["decayProfile"];
    }

    let decayConfig: DecayConfig | undefined;
    if (input.decayConfig && typeof input.decayConfig === "object") {
      const dc = input.decayConfig as Record<string, unknown>;
      decayConfig = {
        lambdaBase: typeof dc.lambdaBase === "number" ? dc.lambdaBase : 0.023,
        lambdaTrust: typeof dc.lambdaTrust === "number" ? dc.lambdaTrust : 0.0116,
        blendAlpha: typeof dc.blendAlpha === "number" ? dc.blendAlpha : 0.7,
        dayEquivalent: typeof dc.dayEquivalent === "number" ? dc.dayEquivalent : 1.0,
      };
    }

    let anchorConfig: AnchorConfig | undefined;
    if (input.anchorConfig && typeof input.anchorConfig === "object") {
      const ac = input.anchorConfig as Record<string, unknown>;
      anchorConfig = {
        familiarityThreshold: typeof ac.familiarityThreshold === "number" ? ac.familiarityThreshold : 20,
        rivalThreshold: typeof ac.rivalThreshold === "number" ? ac.rivalThreshold : 0.3,
        depthIncrement: typeof ac.depthIncrement === "number" ? ac.depthIncrement : 0.15,
        passiveDepthCeiling: typeof ac.passiveDepthCeiling === "number" ? ac.passiveDepthCeiling : 0.3,
        passiveDepthRate: typeof ac.passiveDepthRate === "number" ? ac.passiveDepthRate : 0.01,
      };
    }

    let propagateTags: string[] | undefined;
    if (Array.isArray(input.propagateTags)) {
      propagateTags = (input.propagateTags as unknown[])
        .filter((t): t is string => typeof t === "string");
    }

    let gossipTrait: GossipTrait = "normal";
    if (input.gossipTrait !== undefined) {
      if (!VALID_GOSSIP_TRAITS.has(String(input.gossipTrait))) {
        throw new Error("gossipTrait must be gossipy, discreet, or normal");
      }
      gossipTrait = String(input.gossipTrait) as GossipTrait;
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
      decayProfile,
      decayConfig,
      anchorConfig,
      propagateTags,
      gossipTrait,
    };

    const path = this.profilePath(npcId);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(profile, null, 2), "utf-8");
    renameSync(tmp, path);
    return profile;
  }
}
