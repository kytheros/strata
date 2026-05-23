# Experiment 001 — Within-Session Speaker-Prefer (no DESC)

**Date:** 2026-05-23
**Variable changed:** Added `applyWithinSessionSpeakerPrefer` inside `applyTurnRecencyBoost`
(gated by `CONFIG.search.turnSpeakerPrefer.enabled`, default true).
**Score:** 24/30
**Delta from baseline:** +2 (22/30 → 24/30)

## Variable description

Within each session bucket, hits are reordered so:
1. User turns precede assistant turns (and system turns).
2. Within the same speaker, BM25 (input) order is preserved — no turn-index tiebreaker.
3. BM25 scores are not modified — sort is a pure ordering pass.

The pass runs unconditionally inside `applyTurnRecencyBoost` (before the existing
early-return checks), so it engages even when the recency-aware branch no-ops
(single-session fixtures, historical-veto fixtures, identical-timestamp cases).

Implementation: `src/search/result-ranker.ts` — `applyWithinSessionSpeakerPrefer` (exported).
Config: `src/config.ts` — `CONFIG.search.turnSpeakerPrefer.enabled` (default `true`).

## Per-fixture delta from baseline

| Fixture | Baseline | Post-fix | Delta | Notes |
|---------|----------|---------|-------|-------|
| ranking-001 | 2/2 | 2/2 | 0 | Already at ceiling. |
| ranking-002 | 1/2 | 1/2 | 0 | Bucket 3 (classifier no-fire) — not addressed by speaker-prefer. |
| ranking-003 | 2/2 | 2/2 | 0 | LME port. BM25 already surfaces correct user turn; speaker-prefer preserves it. |
| ranking-004 | 2/2 | **1/2** | **-1** | Partial recall@5 regression — see "Spec corrections" below. top-1 now passes (user turn at rank 1), but recall@5 fails because speaker-prefer concentrates user turns from answer_d00ba6d0_2 into top-5 slots, pushing answer_d00ba6d0_1 out of the recall window. |
| ranking-005 | 2/2 | 2/2 | 0 | LME port. Preserved. |
| ranking-006 | 1/2 | 1/2 | 0 | Single-session correction. Speaker-only cannot fix: both turn_index 0 (alpine) and turn_index 2 (debian-slim) are user turns; BM25 order preserved puts alpine first. Needs follow-up spec (see "Next experiments"). |
| ranking-007 | 1/2 | **2/2** | **+1** | Speaker-prefer promotes user-0 (Postgres 17 decision) above assistant-1 (echo) within r7sess003. |
| ranking-008 | 1/2 | **2/2** | **+1** | Same pattern as 007. ubuntu runner gradient. |
| ranking-009 | 1/2 | **2/2** | **+1** | Historical veto fires correctly; within r9sess001, user-0 ("I'm on Node 20") now precedes assistant-1 ("Node 20 is LTS..."). |
| ranking-010 | 1/2 | 1/2 | 0 | Single-session 5-turn correction. Speaker-only keeps user-0 (Redis) at rank 1; expected is user-2/user-4 (SQLite). Same follow-up spec needed as 006. |
| ranking-011 | 1/2 | 1/2 | 0 | Bucket 2 (newer-noise) — not addressed by speaker-prefer. |
| ranking-012 | 1/2 | 1/2 | 0 | Bucket 2, designed failure — not addressed by speaker-prefer. |
| ranking-013 | 2/2 | 2/2 | 0 | Classifier negative, already at ceiling. |
| ranking-014 | 2/2 | 2/2 | 0 | Same. |
| ranking-015 | 2/2 | 2/2 | 0 | Same. |

**Net: +3 gains (007/008/009), -1 regression (004), net +2.**

## Spec corrections (reference: monorepo commit e8f95b8)

The original spec (2026-05-23-within-session-speaker-prefer-design.md) predicted
+5 (22/30 → 27/30) and included a turn-index DESC tiebreaker within same speaker.
Two errors were discovered during implementation:

**Error 1 — DESC regresses LME fixtures 003/004/005.**
The spec §5 stated that speaker-prefer would be a no-op for 003/004/005 because
"the expected turn IS the user turn." This was wrong. Those LME sessions have
12 turns each with 6 user turns at even indices (0, 2, 4, 6, 8, 10). A DESC
turn-index sort promotes the latest user turns (unrelated to the query) above
the expected turn at index 0. Running with DESC gave 23/30: +5 (006-010) but -4
on 003/004/005 (003: -1, 004: -2, 005: -1). Net +1 — worse than speaker-only.

**Error 2 — Even speaker-only regresses 004 on recall@5.**
Fixture 004 requires BOTH `answer_d00ba6d0_1 turn_index 0` AND
`answer_d00ba6d0_2 turn_index 6` in top-5 (the scorer uses `expected.every()`).
At baseline, assistant turns from `answer_d00ba6d0_2` occupied some top-5 slots,
leaving room for `answer_d00ba6d0_1` to appear. After speaker-only reordering,
user turns from `answer_d00ba6d0_2` fill positions 1–4, crowding out
`answer_d00ba6d0_1` entirely. This is an inherent trade-off of within-session
grouping: concentrating one session's user turns can reduce cross-session
diversity in the top-5 window.

Both errors are documented in the updated spec (monorepo e8f95b8). The DESC
tiebreaker was dropped. The 004 regression is accepted as a known trade-off;
ranking-004 still passes top-1 (was the primary failure mode at baseline).

## Verification of frozen-eval discipline

The `autoresearch-search-retrieval` evals were re-run as a regression check:
- `run-eval.ts`: **29/30** (unchanged from baseline — Q28 permanent FTS5 miss)
- `run-eval-hybrid.ts`: **30/30** (unchanged from 2026-05-22 measurement)

Confirms speaker-prefer has zero effect on the FTS5/hybrid search-retrieval
path; it only affects the turn lane. Speaker-prefer is only reachable via
`applyTurnRecencyBoost`, which is not called on the FTS5/hybrid path.

Full vitest suite: **2204 passed, 55 skipped, 0 failed** (360.81s). No
regressions in any unit or integration test.

## Next experiments to consider

- **Bucket 1 follow-up (006/010) — short-session correction detection.**
  A DESC turn-index tiebreaker gated on session length ≤ N turns (e.g., N=7)
  would fix 006 (3 turns) and 010 (5 turns) without hurting 003/004/005 (12 turns
  each). Needs a new spec. Predicted gain: +2 (24/30 → 26/30).
- **Bucket 2 — per-turn relevance gate on session dominance.**
  Address ranking-011 (cross-topic noise). May not fix ranking-012 without
  semantic understanding. Separate spec.
- **Bucket 3 — classifier marker expansion.**
  Address ranking-002 ("Is X a Y feature?" lacks temporal markers). Separate spec.
- **Fixture 004 recall@5 restoration.**
  Cross-session diversity preservation when speaker-prefer concentrates one session.
  Possible approach: cap per-session hits in top-5 at K after speaker-prefer.
