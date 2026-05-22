# Turn-Lane Ranking AutoResearch Target

Frozen eval that protects ranking quality on the turn-lane retrieval +
ranking pipeline. Catches regression in `applyTurnRecencyBoost`, the
two-signal temporal classifier, the retrieval router, and turn-lane FTS5.

## Quick start

```bash
cd strata
npx tsx autoresearch/turn-lane-ranking/run-eval.ts
```

Runs in <10 seconds. No LLM, no network, in-memory SQLite only.

## Score

| | |
|---|---|
| Ceiling | 30 (15 fixtures × 2 binary signals) |
| Baseline | See `baseline.md` |
| Best | See `best-score.md` |

Each fixture contributes 2 points:
- **Top-1:** any `expected_evidence_turn` at rank 1 → 1 point
- **Recall@5:** all `expected_evidence_turns` in top-5 → 1 point

## Frozen discipline

- `run-eval.ts`, `fixtures/*.json`, and the scoring logic are FROZEN.
- Optimization runs change one variable at a time in `src/config.ts` or `src/search/*`.
- Improvements update `best-score.md` and add a numbered file to `experiments/`.
- Adding or modifying a fixture is an "unfreeze" event (ceiling changes).

## Files

| Path | Purpose |
|---|---|
| `run-eval.ts` | The frozen eval runner |
| `fixtures/` | 15 JSON fixtures (5 ported, 10 hand-authored) |
| `baseline.md` | First measured score, frozen |
| `best-score.md` | Current ceiling |
| `eval-corpus.md` | Corpus narrative |
| `eval-queries.md` | Query list with expected evidence |
| `session-summary.md` | Rolling design notes |
| `experiments/` | Per-iteration logs |

## Spec

`specs/2026-05-22-turn-lane-ranking-autoresearch-design.md`
