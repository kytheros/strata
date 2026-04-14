/**
 * Gossip engine: pure math for NPC-to-NPC disclosure rolls.
 *
 * Side-effect-free. Deterministic under a seed (mulberry32 PRNG).
 *
 * Spec: 2026-04-13-npc-gossip-design.md
 */

export type GossipTrait = "gossipy" | "discreet" | "normal";

export interface DisclosureInput {
  discloserTrait: GossipTrait;
  discloserTrustToListener: number;  // 0..100
  discloserTrustToSubject: number;   // 0..100
  memoryTags: string[];
  propagateTags: string[];
  alreadyHearsay: boolean;
  seed: number;
}

export interface DisclosureOutcome {
  disclosed: boolean;
  roll: number;
  dc: number;
  modifiers: Record<string, number>;
  reason?: "no-propagate-tag-match" | "already-hearsay";
}

const BASE_DC = 15;
const JUICY_DC_MOD = -3;
const SECRET_DC_MOD = 5;
const TRAIT_MOD: Record<GossipTrait, number> = { gossipy: 4, discreet: -4, normal: 0 };

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function d20(seed: number): number {
  return Math.floor(mulberry32(seed)() * 20) + 1;
}

export function rollDisclosure(input: DisclosureInput): DisclosureOutcome {
  if (input.alreadyHearsay) {
    return {
      disclosed: false,
      roll: 0,
      dc: 0,
      modifiers: {},
      reason: "already-hearsay",
    };
  }

  const propagateSet = new Set(input.propagateTags);
  const tagMatch = input.memoryTags.some((t) => propagateSet.has(t));
  if (!tagMatch) {
    return {
      disclosed: false,
      roll: 0,
      dc: 0,
      modifiers: {},
      reason: "no-propagate-tag-match",
    };
  }

  let dc = BASE_DC;
  if (input.memoryTags.includes("juicy")) dc += JUICY_DC_MOD;
  if (input.memoryTags.includes("secret")) dc += SECRET_DC_MOD;

  const trait = TRAIT_MOD[input.discloserTrait];
  const trustListener = Math.round((input.discloserTrustToListener - 50) / 10);
  const trustSubject = -Math.round((input.discloserTrustToSubject - 50) / 10);

  const modifiers = { trait, trustListener, trustSubject };
  const totalMod = trait + trustListener + trustSubject;
  const roll = d20(input.seed);
  const disclosed = roll + totalMod >= dc;

  return { disclosed, roll, dc, modifiers };
}
