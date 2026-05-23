# Experiment 003 — Existential Question Classifier

**Date:** 2026-05-23
**Variable changed:** Added `isExistentialQuestion` sub-classifier matching `^\s*Is\s+.+?\s+(a|an|the)\s+\S+` pattern (lazy multi-word subject to handle "Is semantic search a Pro feature?"), and restructured `isTemporalCurrentStateQuestion` to short-circuit when it fires (historical veto still wins). In `src/search/query-classifier.ts`.
**Score:** 27/30
**Delta from prior:** +1 (from 26/30)
**Commit:** <SHA>

## Variable description

The temporal-current-state classifier previously required at least one of
`hasCurrentStateMarker` (now, today, currently, etc.) to engage recency
dominance. This excluded grammatically present-tense yes/no questions like
"Is X a Y?" that have no explicit temporal cue but are unambiguously asking
about current classification.

The new sub-classifier `isExistentialQuestion(q)` matches the present-tense
existential pattern at the start of the query. The composite classifier
returns true when this fires (subject to the historical veto remaining in
place — "Is X *previously* a Y?" is still vetoed).

**Implementation note:** The spec showed pattern `^Is\s+\S+\s+(a|an|the)\s+\S+`
(single-word subject), but the target query "Is semantic search a Pro feature?"
has a two-word compound subject "semantic search". The deployed regex uses lazy
`.+?` to allow multi-word subjects: `^\s*Is\s+.+?\s+(?:a|an|the)\s+\S+/i`.
All 12 unit tests pass with this pattern; the spec's positive examples all still
hold.

## Per-fixture delta from 26/30 baseline

| Fixture | Prior | This experiment | Delta | Why |
|---------|-------|-----------------|-------|-----|
| ranking-001 | 2/2 | 2/2 | 0 | Query doesn't start with "Is X a Y"; no change. |
| ranking-002 | 1/2 | 2/2 | **+1** | "Is semantic search a Pro feature?" → existential fires → recency dominance engages → newer session at rank 1. |
| ranking-003 | 2/2 | 2/2 | 0 | LME multi-paragraph query; no match. |
| ranking-004 | 1/2 | 1/2 | 0 | Recall@5 regression from speaker-prefer; out of scope for this spec. |
| ranking-005 | 2/2 | 2/2 | 0 | LME; no match. |
| ranking-006 | 2/2 | 2/2 | 0 | "What base image..."; no match. |
| ranking-007 | 2/2 | 2/2 | 0 | "What Postgres version..."; no match. |
| ranking-008 | 2/2 | 2/2 | 0 | "What runner image..."; no match. |
| ranking-009 | 2/2 | 2/2 | 0 | Historical veto wins; no change. |
| ranking-010 | 2/2 | 2/2 | 0 | "What's the storage layer..."; no match. |
| ranking-011 | 1/2 | 1/2 | 0 | Bucket 2 — newer-noise; out of scope. |
| ranking-012 | 1/2 | 1/2 | 0 | Bucket 2; out of scope. |
| ranking-013 | 2/2 | 2/2 | 0 | Historical veto wins; no change. |
| ranking-014 | 2/2 | 2/2 | 0 | Historical veto wins; no change. |
| ranking-015 | 2/2 | 2/2 | 0 | Historical veto wins; no change. |

## Verification of frozen-eval discipline

- `autoresearch-search-retrieval/run-eval.ts`: 29/30 (unchanged — Q28 permanent FTS5 miss).
- `autoresearch-search-retrieval/run-eval-hybrid.ts`: 30/30 (unchanged).

No callsite changes were needed. The new function is added to
`src/search/query-classifier.ts` and the composite is restructured in place.
Every caller of `isTemporalCurrentStateQuestion` (production, harness, frozen
eval) picks up the new behavior automatically.

## Pattern precision

`^\s*Is\s+.+?\s+(?:a|an|the)\s+\S+` is a strict pattern requiring:
1. Start of query (possibly with leading whitespace).
2. The word "Is" (case-insensitive).
3. One or more non-whitespace tokens (the subject — may be compound).
4. An article: a, an, or the.
5. One non-whitespace token (the classification).

This excludes "Was X a Y" (past tense), "What is X" (no article+noun structure
after subject), and "X is a Y" (subject before "is"). The lazy `.+?` means
the regex stops at the first occurrence of an article when scanning the subject,
which handles both single-word ("Is React a framework?") and multi-word
("Is semantic search a Pro feature?") subjects correctly.

On the current corpus, only ranking-002 matches. No false positives.

## Next experiments to consider

- Per-session top-5 cap to recover ranking-004 (+1 → 28/30).
- Bucket 2 newer-noise gate for ranking-011 (012 may be unsolvable without semantics).
- Broader existential patterns (Are, Does, Has) if future fixtures justify.
