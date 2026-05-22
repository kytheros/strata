# Turn-Lane Ranking — Session Summary

## 2026-05-22 — Target created

Initial baseline measured at 22/30. See `baseline.md` for per-fixture detail.

### Why this target exists

The five existing AutoResearch targets all bypass the turn lane. The
`c694596` default-flip of `turnRecencyBoost.enabled` surfaced this gap:
baseline-vs-treatment AutoResearch scores were guaranteed identical
because the flag lives outside the evaluated code path. The real
validation lived in `evals/distillation-e2e/`, which depends on live
GPT-4o calls and tests the answer model, not the ranker.

This target closes that gap with a pure-local FTS5-only eval.

### Design highlights

- 15 fixtures covering: ports (5), gradients (2), classifier negatives (3),
  same-session edge (1), cross-topic noise (1), historical negative (1),
  fall-through (1), newer-noise documented limitation (1).
- Scoring: top-1 + recall@5 = 2 points per fixture, ceiling 30.
- Fixture #012 designed to fail top-1; documents the per-turn relevance
  threshold improvement direction.
- Actual baseline 22/30 (lower than the 25–29 spec prediction). All 8
  failures are 1/2 (recall@5 passes, top-1 fails). No 0/2 failures.

### Key findings from baseline run

1. The 3 LME fixtures (003-005) all score 2/2 — FTS5 content matching
   surfaces the answer sessions reliably despite 46-49 session depth.
2. The 3 classifier-negative fixtures (013-015) all score 2/2 — historical
   phrasing veto is working correctly.
3. 8 fixtures fail top-1 due to within-session BM25 ordering (assistant
   turn before user turn, or initial mention before later correction).
4. ranking-012 fails top-1 as designed (Terraform noise in newer session).
5. ranking-011 confirms recency dominance fires on "currently" even when
   newest session content is completely unrelated to the query.

### Frozen as of

Commit (to be filled after push) on `origin/main`.
