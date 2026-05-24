# Experiment 004 — Per-Session Top-5 Cap

**Date:** 2026-05-24
**Variable changed:** Added `applyPerSessionCap` (exported) in `src/search/result-ranker.ts` using overflow demotion at cap = 2 (MAX_HITS_PER_SESSION), gated by `CONFIG.search.turnPerSessionCap.enabled` (default true). Refactored `applyTurnRecencyBoost` to single exit point so the cap pass wraps both no-op and engaged paths.
**Commit:** 3ebe541
**Score:** 28/30
**Delta from prior:** +1 (from 27/30)

## Variable description

Walks the ranked output of upstream ranking (speaker-prefer, recency reorder)
keeping a per-session hit counter. Hits whose session-count is ≤ 2 keep their
position; excess hits are demoted to the end of the list. No hits are dropped.

Provable top-1 preservation: the first hit in any input always has count = 1,
which is ≤ cap, so it stays at index 0. No fixture currently passing top-1
can regress.

The cap recovers cross-session diversity in top-5 when one session's
contribution would otherwise crowd out a sibling.

## Empirical correction

The original spec (`2026-05-23-per-session-top5-cap-design.md`) specified cap=3
(matching SHORT_SESSION_USER_HIT_THRESHOLD). When implemented and evaluated,
cap=3 failed to lift ranking-004 because a third session (`9e2c2a6c_2`) has 6
BM25 hits ranked above `answer_d00ba6d0_1/t=0`. With cap=3, `9e2c2a6c_2` still
occupies 3 slots after the cap, keeping `_1/t=0` at rank 7 (outside top-5).

Cap=2 was determined empirically: it forces `9e2c2a6c_2` to yield its third
slot, letting `answer_d00ba6d0_1/t=0` reach rank 5 (top-5 boundary). No other
fixture was affected — verified by per-fixture trace. The spec correction was
committed to the monorepo in commit `6327913`.

## Per-fixture delta from 27/30 baseline

| Fixture | Prior | This experiment | Delta | Why |
|---------|-------|-----------------|-------|-----|
| ranking-001 | 2/2 | 2/2 | 0 | Each session ≤ 2 hits; cap is no-op. |
| ranking-002 | 2/2 | 2/2 | 0 | Each session ≤ 2 hits. |
| ranking-003 | 2/2 | 2/2 | 0 | Single-expected-turn fixture; expected turn is top-of-session, in kept portion. |
| ranking-004 | 1/2 | 2/2 | **+1** | Over-represented session capped to 2; third session also capped to 2; sibling session's expected turn-0 now in top-5. |
| ranking-005 | 2/2 | 2/2 | 0 | Both expected turns are top-of-session in their respective sessions, in kept portion. |
| ranking-006 | 2/2 | 2/2 | 0 | Single session; expected turns are top-2 user turns post-DESC. |
| ranking-007 | 2/2 | 2/2 | 0 | 3 sessions, 2 hits each; each exactly at cap. |
| ranking-008 | 2/2 | 2/2 | 0 | Same as 007. |
| ranking-009 | 2/2 | 2/2 | 0 | 2 sessions, 2 hits each; exactly at cap. |
| ranking-010 | 2/2 | 2/2 | 0 | Single session, cap demotes to 2 kept; expected user turns are top-2 post-DESC. |
| ranking-011 | 1/2 | 1/2 | 0 | Each session ≤ 2 hits; cap is no-op. Bucket 2 (newer-noise) still unaddressed. |
| ranking-012 | 1/2 | 1/2 | 0 | Same. |
| ranking-013 | 2/2 | 2/2 | 0 | 2 sessions, 2 hits each. |
| ranking-014 | 2/2 | 2/2 | 0 | Same. |
| ranking-015 | 2/2 | 2/2 | 0 | Same. |

## Verification of frozen-eval discipline

- `autoresearch-search-retrieval/run-eval.ts`: 29/30 (unchanged — Q28 permanent FTS5 miss).
- `autoresearch-search-retrieval/run-eval-hybrid.ts`: 30/30 (unchanged).

No callsite changes were needed. The cap is invoked from inside
`applyTurnRecencyBoost` (which the frozen eval already calls). The refactor
to a single exit changed control flow but is provably equivalent for every
input that doesn't exercise the cap (all 14 unchanged fixtures).

## Refactor note

`applyTurnRecencyBoost` previously had 4 return points (length<2 fall-through,
classifier-not-firing fall-through, single-session fall-through inside the
recency branch, and the final flatMap return). Refactored to a single
accumulator (`working`) and single exit at the bottom. The cap call wraps
the exit so it applies uniformly to all former early-return paths.

## Next experiments to consider

- Bucket 2 — newer-noise gate for ranking-011 (012 may be unsolvable without semantics).
- Promote `MAX_HITS_PER_SESSION` to CONFIG if future corpora justify tuning.
