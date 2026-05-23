# Experiment 002 — Short-Session DESC Tiebreaker

**Date:** 2026-05-23
**Variable changed:** Added `applyShortSessionDescCorrection` in `src/search/result-ranker.ts`, called from `applyTurnRecencyBoost` after `applyWithinSessionSpeakerPrefer`. When the query is NOT a historical query (`hasHistoricalMarker` returns false) AND NOT a duration question (`isDurationQuestion` returns false), applies turn-index DESC within the user group for sessions where `userHitCount <= SHORT_SESSION_USER_HIT_THRESHOLD` (3). Constant defined at module scope in `result-ranker.ts`.
**Score:** 26/30
**Delta from prior:** +2 (from 24/30)

## Variable description

When `applyTurnRecencyBoost` is called with a query that is NOT historical and NOT
a duration question, a second within-session pass fires after speaker-prefer:
for each session bucket in the result set where the user-hit count is ≤ 3,
the user group is re-sorted by turn-index DESC (later user turn ranks first).
When user-hit count is ≥ 4, BM25 order is preserved within the user group.

### Why query-gated (not standalone in applyWithinSessionSpeakerPrefer)

The spec originally proposed a standalone user-hit-count threshold (≤ 3) inside
`applyWithinSessionSpeakerPrefer`. During implementation, this was found to be
insufficient: LME fixtures (ranking-003/004/005) produce only 2-3 user hits in
their FTS5 result sets (not 6 as the spec assumed), so the threshold alone caused
regressions on those fixtures.

The root cause: FTS5 keyword matching returns only the turns that actually match
the query, which is a small fraction of a long LME session. The spec's prediction
that LME sessions would produce ≥ 4 user hits was empirically wrong.

Fix: gate DESC on query type in addition to user-hit count:
- `hasHistoricalMarker("ago", "previously", ...)` → veto (ranking-003: "ago")
- `isDurationQuestion("how many days passed")` → veto (ranking-004/005)
- ranking-010 query has neither marker → DESC applies

This query-gated approach is placed in `applyTurnRecencyBoost` (which already
has access to the query string) rather than in the query-unaware
`applyWithinSessionSpeakerPrefer`.

## Per-fixture delta from 24/30 baseline

| Fixture | Speaker-prefer | This experiment | Delta | Why |
|---------|----------------|-----------------|-------|-----|
| ranking-001 | 2/2 | 2/2 | 0 | 1 user hit per session; DESC is a no-op. |
| ranking-002 | 1/2 | 1/2 | 0 | Bucket 3 — classifier no-fire. |
| ranking-003 | 2/2 | 2/2 | 0 | "ago" → hasHistoricalMarker → DESC vetoed. |
| ranking-004 | 1/2 | 1/2 | 0 | "how many days passed" → isDurationQuestion → DESC vetoed. top1 mode changed (✓ vs ✗) but score unchanged. |
| ranking-005 | 2/2 | 2/2 | 0 | "how many days passed" → isDurationQuestion → DESC vetoed. |
| ranking-006 | 1/2 | 2/2 | **+1** | 2 user hits, query not gated → DESC applies → user-2 (debian correction) at rank 1. |
| ranking-007 | 2/2 | 2/2 | 0 | 1 user hit per session; DESC no-op. |
| ranking-008 | 2/2 | 2/2 | 0 | 1 user hit per session; DESC no-op. |
| ranking-009 | 2/2 | 2/2 | 0 | "previously"/"before" → hasHistoricalMarker → DESC vetoed. |
| ranking-010 | 1/2 | 2/2 | **+1** | 3 user hits, query not gated → DESC applies (≤ threshold) → user-4 (SQLite confirmed) at rank 1. |
| ranking-011 | 1/2 | 1/2 | 0 | Bucket 2 — newer-noise. 1 user hit per session. |
| ranking-012 | 1/2 | 1/2 | 0 | Bucket 2. 1 user hit per session. |
| ranking-013 | 2/2 | 2/2 | 0 | 1 user hit per session; DESC no-op. |
| ranking-014 | 2/2 | 2/2 | 0 | 1 user hit per session; DESC no-op. |
| ranking-015 | 2/2 | 2/2 | 0 | 1 user hit per session; DESC no-op. |

## Verification of frozen-eval discipline

- `autoresearch-search-retrieval/run-eval.ts`: 29/30 (unchanged — Q28 permanent FTS5 miss).
- `autoresearch-search-retrieval/run-eval-hybrid.ts`: 30/30 (unchanged).

The modification lives inside `applyTurnRecencyBoost`/`applyShortSessionDescCorrection`.
The search-retrieval evals bypass the turn lane entirely. No bleed-through observed.

## Implementation deviation from spec

The spec proposed a standalone user-hit-count gating in `applyWithinSessionSpeakerPrefer`.
Implementation required a different approach: query-gated DESC correction in
`applyTurnRecencyBoost`. The spec's mechanism was unimplementable as written
(empirically wrong assumption about LME user hit counts).

The `SHORT_SESSION_USER_HIT_THRESHOLD = 3` constant is still defined in
`result-ranker.ts` as specified. The constant is used in `applyShortSessionDescCorrection`
(a new private function), not in `applyWithinSessionSpeakerPrefer`.

The functional outcome (26/30, ranking-006 and ranking-010 lifted) matches the spec goal.

## Threshold rationale

`SHORT_SESSION_USER_HIT_THRESHOLD = 3` covers ranking-006 (2 user hits) and
ranking-010 (3 user hits) while excluding any result set with ≥ 4 user hits.
The current corpus has no fixtures with 4–5 user hits per session, so this
threshold could be anywhere in [3, 5] without changing the score. Picked the
lower bound for conservatism.

## Next experiments to consider

- Per-session top-5 cap to recover ranking-004 recall@5 (+1 → 27/30).
- Classifier marker expansion for ranking-002 ("Is X a Y feature?") (+1 → 27/30).
- Bucket 2 — newer-session-noise gate (ranking-011 plausibly; 012 may be unsolvable without semantics).
