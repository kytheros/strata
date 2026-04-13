/**
 * Tag-rule engine: computes trust deltas from memory tags weighted
 * by NPC alignment.
 *
 * Default alignment → tag-weight matrix (ethical axis) + moral
 * multiplier. Per-NPC overrides via optional tagRules field.
 *
 * Spec: 2026-04-12-npc-profile-player-alignment-design.md Section 1.
 */

export interface NpcAlignment {
  ethical: "lawful" | "neutral" | "chaotic";
  moral: "good" | "neutral" | "evil";
}

export interface TagRuleOverrides {
  [tag: string]: { trust: number };
}

export interface ExtendedTagRule {
  trust: number;
  promoteAnchor?: boolean;
  breakAnchor?: boolean;
  minAnchorDepth?: number;
}

export interface AnchorOutcome {
  shouldPromote: boolean;
  shouldBreak: boolean;
  minAnchorDepth: number;
}

export interface TrustDelta {
  trust: number;
}

/**
 * Default tag-weight matrix keyed by ethical axis.
 * Each entry maps a tag pattern to a trust delta.
 */
const DEFAULT_WEIGHTS: Record<string, Record<string, number>> = {
  lawful: {
    crime: -0.4, theft: -0.4, fraud: -0.4,
    violence: -0.3, assault: -0.3,
    cooperation: 0.15, help: 0.15, labor: 0.15,
    trade: 0.1, commerce: 0.1,
    deception: -0.35, lie: -0.35,
    loyalty: 0.2, oath: 0.2,
  },
  neutral: {
    crime: -0.2, theft: -0.2, fraud: -0.2,
    violence: -0.3, assault: -0.3,
    cooperation: 0.1, help: 0.1, labor: 0.1,
    trade: 0.1, commerce: 0.1,
    deception: -0.15, lie: -0.15,
    loyalty: 0.1, oath: 0.1,
  },
  chaotic: {
    crime: -0.05, theft: -0.05, fraud: -0.05,
    violence: -0.15, assault: -0.15,
    cooperation: 0.05, help: 0.05, labor: 0.05,
    trade: 0.1, commerce: 0.1,
    deception: 0.0, lie: 0.0,
    loyalty: -0.05, oath: -0.05,
  },
};

/**
 * Moral axis multiplier applied after the ethical-axis lookup.
 *   Good:    positive deltas × 1.2, negative deltas × 1.0
 *   Neutral: all deltas × 1.0
 *   Evil:    all deltas × 0.8
 */
function moralMultiplier(moral: NpcAlignment["moral"], baseDelta: number): number {
  if (moral === "good") return baseDelta > 0 ? baseDelta * 1.2 : baseDelta;
  if (moral === "evil") return baseDelta * 0.8;
  return baseDelta;
}

/**
 * Default anchor-eligible tags with trust deltas and anchor flags.
 * Game developers can override per-NPC via tagRules in profile.json.
 */
export const DEFAULT_ANCHOR_TAGS: Record<string, ExtendedTagRule> = {
  "saved-my-life": { trust: 0.4, promoteAnchor: true, minAnchorDepth: 0.6 },
  "sworn-oath":    { trust: 0.2, promoteAnchor: true },
  "family-bond":   { trust: 0.1, promoteAnchor: true, minAnchorDepth: 0.8 },
  "sacrifice":     { trust: 0.3, promoteAnchor: true, minAnchorDepth: 0.5 },
  "shared-trauma": { trust: 0.15, promoteAnchor: true, minAnchorDepth: 0.4 },
  "betrayal":      { trust: -0.5, breakAnchor: true },
  "murder":        { trust: -0.8, breakAnchor: true },
  "atrocity":      { trust: -1.0, breakAnchor: true },
  "oath-breaking": { trust: -0.6, breakAnchor: true },
};

/**
 * Compute the aggregate trust delta for a set of tags, given the NPC's
 * alignment and optional per-NPC tagRules override.
 *
 * Tags not found in the matrix or overrides are silently ignored (zero delta).
 * Multiple matching tags stack additively.
 */
export function computeTrustDelta(
  tags: string[],
  alignment: NpcAlignment,
  tagRules?: TagRuleOverrides | null
): TrustDelta {
  let total = 0;
  for (const tag of tags) {
    const lower = tag.toLowerCase();
    // Per-NPC override takes priority
    if (tagRules && lower in tagRules) {
      total += moralMultiplier(alignment.moral, tagRules[lower].trust);
      continue;
    }
    // Default matrix lookup
    const ethicalWeights = DEFAULT_WEIGHTS[alignment.ethical];
    if (ethicalWeights && lower in ethicalWeights) {
      total += moralMultiplier(alignment.moral, ethicalWeights[lower]);
      continue;
    }
    // Anchor tag fallback — tags like "saved-my-life" have trust deltas
    // even if not in the alignment-based DEFAULT_WEIGHTS matrix.
    const anchorTag = DEFAULT_ANCHOR_TAGS[lower];
    if (anchorTag) {
      total += moralMultiplier(alignment.moral, anchorTag.trust);
    }
    // Unknown tags produce zero delta — silently ignored
  }
  return { trust: Math.round(total * 1000) / 1000 }; // avoid float noise
}

/**
 * Scan tags for anchor-eligible outcomes. Checks per-NPC tagRules first,
 * then falls back to DEFAULT_ANCHOR_TAGS.
 */
export function computeAnchorOutcome(
  tags: string[],
  tagRules?: Record<string, ExtendedTagRule> | null
): AnchorOutcome {
  let shouldPromote = false;
  let shouldBreak = false;
  let minAnchorDepth = 0;

  for (const tag of tags) {
    const lower = tag.toLowerCase();
    const rule: ExtendedTagRule | undefined =
      (tagRules && lower in tagRules) ? tagRules[lower] : DEFAULT_ANCHOR_TAGS[lower];
    if (!rule) continue;
    if (rule.promoteAnchor) {
      shouldPromote = true;
      if (rule.minAnchorDepth !== undefined && rule.minAnchorDepth > minAnchorDepth) {
        minAnchorDepth = rule.minAnchorDepth;
      }
    }
    if (rule.breakAnchor) {
      shouldBreak = true;
    }
  }
  return { shouldPromote, shouldBreak, minAnchorDepth };
}

/** Clamp trust to [-1.0, 1.0]. */
export function clampTrust(value: number): number {
  return Math.max(-1.0, Math.min(1.0, value));
}

/** Derive disposition label from trust value. */
export function trustToDisposition(trust: number): string {
  if (trust < -0.5) return "hostile";
  if (trust < 0) return "suspicious";
  if (trust < 0.3) return "wary";
  if (trust < 0.7) return "friendly";
  return "devoted";
}
