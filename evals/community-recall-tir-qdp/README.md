# Community Recall TIR + QDP Eval (Frozen)

Scores the recall path produced by `SqliteKnowledgeTurnStore` + `fuseCommunityLanes` + `recallQdpCommunity`
against ten hand-curated scenarios that recreate the Community retrieval failure modes documented in the
TIR+QDP design spec.

Spec: `specs/2026-05-01-tirqdp-community-port-plan.md` §TIRQDP-1.10.

Run:

    cd strata
    npx tsx evals/community-recall-tir-qdp/eval.ts

Ship gate:

| Score | Decision |
|---|---|
| ≥ 9/10 scenarios pass | SHIP |
| 7–8/10 pass | INVESTIGATE — below ship gate |
| < 7/10 pass | RE-EVALUATE |

Scenario coverage:

| # | Scenario | Failure mode exercised |
|---|---|---|
| 01 | buried-fact-long-session | Fact stated once across 50 turns |
| 02 | distractor-saturation | 30 filler turns + 1 factual turn |
| 03 | redundancy-near-duplicate | 5 near-duplicate turns; QDP dedupe |
| 04 | cross-project-isolation | Same query scoped to project A never returns project B |
| 05 | cross-user-isolation | Same query scoped to user X never returns user Y content |
| 06 | solution-bias | Fix/resolve language surfaces error_fix entry |
| 07 | recency-prefer-on-conflict | Newer turn overrides older conflicting value |
| 08 | multi-session-merge | Fact split across 2 sessions; both pieces recoverable |
| 09 | query-coverage-floor | Pure stem-mismatch result excluded by QDP |
| 10 | seed-only-baseline | Single entry, single query (sanity) |

DO NOT modify `eval.ts` or `scenarios/**` during optimization. The script is the source of truth.
