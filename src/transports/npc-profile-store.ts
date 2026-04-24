/**
 * NPC profile store — read/write shared NPC profiles against the
 * world.db `npc_profiles` table.
 *
 * Profiles are shared across all players in a world. Admin-write, player-read.
 * Hot fields are individual columns; complex structures are JSON columns.
 *
 * Spec: 2026-04-15-world-scope-refactor-design.md
 */

import type Database from "better-sqlite3";

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

export type RefusalStyle = "gruff" | "evasive" | "apologetic" | "silent";

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
  refusalStyle: RefusalStyle;
  refusalExample?: string;
}

const VALID_ETHICAL = new Set(["lawful", "neutral", "chaotic"]);
const VALID_MORAL = new Set(["good", "neutral", "evil"]);
const VALID_DECAY_PROFILES = new Set(["sharp", "normal", "fading", "custom"]);
const VALID_GOSSIP_TRAITS = new Set(["gossipy", "discreet", "normal"]);
const VALID_REFUSAL_STYLES = new Set<RefusalStyle>(["gruff", "evasive", "apologetic", "silent"]);

export class NpcProfileStore {
  private readonly db: Database.Database;

  // Prepared statements cached on construction
  private readonly stmtUpsert: Database.Statement;
  private readonly stmtGet: Database.Statement;
  private readonly stmtList: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    this.stmtUpsert = db.prepare(`
      INSERT INTO npc_profiles (
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
      ON CONFLICT(npc_id) DO UPDATE SET
        name = excluded.name,
        role = excluded.role,
        alignment_ethical = excluded.alignment_ethical,
        alignment_moral = excluded.alignment_moral,
        default_trust = excluded.default_trust,
        gossip_trait = excluded.gossip_trait,
        decay_profile_name = excluded.decay_profile_name,
        factions_json = excluded.factions_json,
        faction_biases_json = excluded.faction_biases_json,
        propagate_tags_json = excluded.propagate_tags_json,
        tag_rules_json = excluded.tag_rules_json,
        decay_config_json = excluded.decay_config_json,
        extras_json = excluded.extras_json,
        updated_at = excluded.updated_at
    `);

    this.stmtGet = db.prepare(`
      SELECT * FROM npc_profiles WHERE npc_id = ?
    `);

    this.stmtList = db.prepare(`
      SELECT * FROM npc_profiles ORDER BY name
    `);
  }

  /** Read a profile by NPC ID. Returns null if not found. */
  get(npcId: string): NpcProfile | null {
    const row = this.stmtGet.get(npcId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToProfile(row);
  }

  /** Write/upsert a profile. Validates input and returns the stored profile. Throws on invalid input. */
  put(npcId: string, input: Record<string, unknown>): NpcProfile {
    const profile = this.validateAndBuild(input);
    this.stmtUpsert.run({
      npc_id: npcId,
      name: profile.name,
      role: profile.title ?? null,
      alignment_ethical: profile.alignment.ethical,
      alignment_moral: profile.alignment.moral,
      // Store trust as integer 0..100 mapped from -1..1 float. Use * 100 + 50 to keep precision.
      // Actually the schema stores INTEGER but the domain uses -1..1 floats.
      // Store as a scaled integer: round(trust * 10000) to preserve 4 decimal places.
      // Wait — the schema says INTEGER DEFAULT 50. Let's store as real multiplied by 10000
      // and reconstruct. Better: just store as TEXT representation or change the scale.
      // The schema comment says "default 50" in 0..100 range, but NpcProfile uses -1..1.
      // Decision: store as scaled integer (trust * 10000, range -10000..10000).
      default_trust: Math.round(profile.defaultTrust * 10000),
      gossip_trait: profile.gossipTrait,
      decay_profile_name: profile.decayProfile ?? "normal",
      // faction is stored in extras_json alongside other optional fields
      factions_json: profile.faction ? JSON.stringify([profile.faction]) : null,
      faction_biases_json: JSON.stringify(profile.factionBias),
      propagate_tags_json: profile.propagateTags ? JSON.stringify(profile.propagateTags) : null,
      tag_rules_json: profile.tagRules ? JSON.stringify(profile.tagRules) : null,
      decay_config_json: profile.decayConfig ? JSON.stringify(profile.decayConfig) : null,
      // Pack extras. `decayProfileExplicit` is a sentinel: the decay_profile_name
      // column stores "normal" for both "user explicitly selected normal" and
      // "user left it unset" — this flag disambiguates so the former round-trips.
      extras_json: JSON.stringify({
        traits: profile.traits,
        backstory: profile.backstory,
        title: profile.title,
        anchorConfig: profile.anchorConfig,
        refusalStyle: profile.refusalStyle,
        refusalExample: profile.refusalExample,
        decayProfileExplicit: profile.decayProfile !== undefined,
      }),
      now: Date.now(),
    });
    return profile;
  }

  /** List all profiles ordered by name. */
  list(): NpcProfile[] {
    const rows = this.stmtList.all() as Record<string, unknown>[];
    return rows.map(r => this.rowToProfile(r));
  }

  private rowToProfile(row: Record<string, unknown>): NpcProfile {
    const extras = row.extras_json
      ? (JSON.parse(row.extras_json as string) as Record<string, unknown>)
      : {};

    const tagRulesRaw = row.tag_rules_json
      ? (JSON.parse(row.tag_rules_json as string) as NpcProfile["tagRules"])
      : null;

    const decayConfigRaw = row.decay_config_json
      ? (JSON.parse(row.decay_config_json as string) as DecayConfig)
      : undefined;

    const anchorConfigRaw = extras.anchorConfig
      ? (extras.anchorConfig as AnchorConfig)
      : undefined;

    const propagateTagsRaw = row.propagate_tags_json
      ? (JSON.parse(row.propagate_tags_json as string) as string[])
      : undefined;

    const factionBiasRaw = row.faction_biases_json
      ? (JSON.parse(row.faction_biases_json as string) as Record<string, number>)
      : {};

    // Reconstruct faction from factions_json (first element)
    let faction: string | undefined;
    if (row.factions_json) {
      const arr = JSON.parse(row.factions_json as string) as string[];
      faction = arr[0];
    }

    // Reconstruct trust float from scaled integer
    const defaultTrust = typeof row.default_trust === "number"
      ? row.default_trust / 10000
      : 0;

    // decayProfile: if stored as "normal" but was not explicitly set, return undefined
    // We use null in extras_json to distinguish "not set" from "normal"
    const decayProfileName = row.decay_profile_name as string | null;
    const decayProfile = decayProfileName && decayProfileName !== "normal"
      ? (decayProfileName as NpcProfile["decayProfile"])
      : (extras.decayProfileExplicit
          ? (decayProfileName as NpcProfile["decayProfile"])
          : undefined);

    const refusalStyle: RefusalStyle = VALID_REFUSAL_STYLES.has(extras.refusalStyle as RefusalStyle)
      ? (extras.refusalStyle as RefusalStyle)
      : "evasive";

    const refusalExample: string | undefined =
      typeof extras.refusalExample === "string" && extras.refusalExample.length > 0
        ? extras.refusalExample
        : undefined;

    return {
      name: row.name as string,
      title: (extras.title as string | undefined) ?? undefined,
      alignment: {
        ethical: row.alignment_ethical as NpcAlignment["ethical"],
        moral: row.alignment_moral as NpcAlignment["moral"],
      },
      faction,
      traits: Array.isArray(extras.traits) ? (extras.traits as string[]) : [],
      backstory: typeof extras.backstory === "string" ? extras.backstory : "",
      defaultTrust,
      factionBias: factionBiasRaw,
      tagRules: tagRulesRaw ?? null,
      decayProfile,
      decayConfig: decayConfigRaw,
      anchorConfig: anchorConfigRaw,
      propagateTags: propagateTagsRaw,
      gossipTrait: (row.gossip_trait as GossipTrait) ?? "normal",
      refusalStyle,
      refusalExample,
    };
  }

  private validateAndBuild(input: Record<string, unknown>): NpcProfile {
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

    let refusalStyle: RefusalStyle = "evasive";
    if (input.refusalStyle !== undefined) {
      if (!VALID_REFUSAL_STYLES.has(String(input.refusalStyle) as RefusalStyle)) {
        throw new Error("refusalStyle must be gruff|evasive|apologetic|silent");
      }
      refusalStyle = String(input.refusalStyle) as RefusalStyle;
    }

    let refusalExample: string | undefined;
    if (typeof input.refusalExample === "string" && input.refusalExample.length > 0) {
      refusalExample = input.refusalExample;
    }

    return {
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
      refusalStyle,
      refusalExample,
    };
  }
}
