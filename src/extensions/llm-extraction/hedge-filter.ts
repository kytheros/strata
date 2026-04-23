/**
 * Hedge filter — downgrades hedged extractions to `hearsay`-tagged, low-
 * importance rows instead of confident atomic facts. See
 * specs/2026-04-22-npc-narrative-integrity-design.md (Fix 1).
 *
 * Two-layer defense: the extraction prompt instructs the LLM to set
 * `hearsay: true` on hedged facts, AND this module deterministically
 * re-checks the source sentence with a compiled regex. Either layer alone
 * downgrades the fact; neither alone is sufficient.
 */

import type { AtomicFact } from "./utterance-extractor.js";

const HEDGE_MARKERS = [
  "i've heard",
  "i have heard",
  "i hear",
  "there's talk",
  "there is talk",
  "there is rumor",
  "rumored",
  "rumors of",
  "haven't seen",
  "have not seen",
  "not sure if",
  "might be",
  "supposedly",
  "word is",
  "word has it",
  "they say",
  "some say",
  "folks say",
  "allegedly",
  "believed to",
  "said to be",
  "whispers of",
  "i've heard tell",
];

const HEDGE_REGEX = new RegExp(
  `\\b(?:${HEDGE_MARKERS.map(escapeRegex).join("|")})\\b`,
  "i",
);

const RUMOR_PREFIXES = [
  "it is rumored",
  "word has it",
  "there is rumor",
  "i have heard",
  "i've heard",
  "hearsay says",
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function detectHedge(sentence: string): boolean {
  if (!sentence) return false;
  return HEDGE_REGEX.test(sentence);
}

export function rewriteAsRumor(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const lower = trimmed.toLowerCase();
  for (const prefix of RUMOR_PREFIXES) {
    if (lower.startsWith(prefix)) return trimmed;
  }
  const head = trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
  return `it is rumored that ${head}`;
}

function getImportanceCeil(): number {
  const raw = Number(process.env.STRATA_HEARSAY_IMPORTANCE_CEIL);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 100) return Math.floor(raw);
  return 40;
}

export function applyHedgeFilter(
  facts: AtomicFact[],
  sourceText: string,
): AtomicFact[] {
  if (process.env.STRATA_HEDGE_FILTER_ENABLED === "false") return facts;
  const sourceIsHedge = detectHedge(sourceText);
  const ceil = getImportanceCeil();
  return facts.map((fact) => {
    // Spec's three-arm check includes detectHedge(fact.sourceSentence), but
    // AtomicFact has no sourceSentence field — callers pass raw job.text,
    // which is the full pre-sanitization source and covers the practical case.
    const fromHedge = fact.hearsay === true || sourceIsHedge;
    if (!fromHedge) return fact;
    const nextTags = Array.from(new Set([...(fact.tags ?? []), "hearsay"]));
    const nextImportance = typeof fact.importance === "number"
      ? Math.min(fact.importance, ceil)
      : ceil;
    return {
      ...fact,
      tags: nextTags,
      importance: nextImportance,
      text: rewriteAsRumor(fact.text),
    };
  });
}
