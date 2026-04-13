/**
 * Decay engine: pure math for memory retention and trust decay.
 *
 * All functions are side-effect-free. Decay is computed at query time,
 * never mutating stored data.
 *
 * Spec: 2026-04-13-npc-tunable-decay-design.md Sections 1-2.
 */

export interface DecayProfile {
  lambdaBase: number;     // Memory decay rate
  lambdaTrust: number;    // Trust decay rate
  blendAlpha: number;     // Time vs. interaction weight (0-1)
  dayEquivalent: number;  // Interaction-to-day conversion
}

export const NAMED_PROFILES: Record<string, DecayProfile> = {
  sharp:  { lambdaBase: 0,     lambdaTrust: 0,      blendAlpha: 0.7, dayEquivalent: 1.0 },
  normal: { lambdaBase: 0.023, lambdaTrust: 0.0116, blendAlpha: 0.7, dayEquivalent: 1.0 },
  fading: { lambdaBase: 0.099, lambdaTrust: 0.046,  blendAlpha: 0.5, dayEquivalent: 2.0 },
};

/**
 * Resolve a named or custom decay profile. Falls back to "normal" for
 * unknown profile names or missing custom config.
 */
export function resolveProfile(
  profileName?: string,
  customConfig?: Partial<DecayProfile>
): DecayProfile {
  if (profileName === "custom" && customConfig) {
    return {
      lambdaBase: customConfig.lambdaBase ?? 0.023,
      lambdaTrust: customConfig.lambdaTrust ?? 0.0116,
      blendAlpha: customConfig.blendAlpha ?? 0.7,
      dayEquivalent: customConfig.dayEquivalent ?? 1.0,
    };
  }
  return NAMED_PROFILES[profileName ?? "normal"] ?? NAMED_PROFILES.normal;
}

/**
 * Compute memory retention as a 0-1 multiplier on search/recall ranking.
 *
 * retention = e^(-lambda_eff * effectiveAge)
 * effectiveAge = alpha * ageDays + (1-alpha) * interactionsSinceMention * dayEquivalent
 * lambda_eff = lambdaBase * (1 - anchorDepth * 0.8)
 */
export function memoryRetention(
  ageDays: number,
  interactionsSinceMention: number,
  profile: DecayProfile,
  anchorDepth: number = 0
): number {
  if (profile.lambdaBase === 0) return 1.0;
  const lambdaEff = profile.lambdaBase * (1 - anchorDepth * 0.8);
  const effectiveAge =
    profile.blendAlpha * ageDays +
    (1 - profile.blendAlpha) * interactionsSinceMention * profile.dayEquivalent;
  return Math.exp(-lambdaEff * effectiveAge);
}

/**
 * Compute effective trust after time-based decay toward a resting point.
 *
 * effectiveTrust = restingTrust + (storedTrust - restingTrust) * e^(-lambdaTrust * days)
 */
export function trustDecay(
  storedTrust: number,
  restingTrust: number,
  daysSinceLastInteraction: number,
  profile: DecayProfile
): number {
  if (profile.lambdaTrust === 0) return storedTrust;
  return (
    restingTrust +
    (storedTrust - restingTrust) *
      Math.exp(-profile.lambdaTrust * daysSinceLastInteraction)
  );
}

/**
 * Amplify a trust delta by anchor depth.
 * amplifiedDelta = baseDelta * (1 + anchorDepth * 1.5)
 */
export function amplifyDelta(baseDelta: number, anchorDepth: number): number {
  return baseDelta * (1 + anchorDepth * 1.5);
}
