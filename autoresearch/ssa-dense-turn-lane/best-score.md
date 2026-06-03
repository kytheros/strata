# Best Score — Dense Turn-Lane (single-session-assistant)

**Ship gate (spec 2026-06-02-dense-turn-lane-design §8.3):** the dense turn-lane is validated only if, on a matched full-500 OFF-vs-ON run, **Arm A** (SSA slice) shows a stable lift AND **Arm B** (every other category) stays flat within noise.

| Variant | Task-avg | Raw | SSA slice | Date | Notes |
|---|---|---|---|---|---|
| OFF (baseline) | 80.81% | 80.60% | 76.8% (43/56) | 2026-06-03 | Vertex temp-0, run-id `vtx-off` |
| **ON (dense turn-lane)** | **84.43%** | **84.80%** | **98.2% (55/56)** | 2026-06-03 | Vertex temp-0, run-id `vtx-on` |
| **Δ** | **+3.61pp** | **+4.20pp** | **+21.4pp** | | |

## Per-category (OFF → ON)
| Category | OFF | ON | Δ |
|---|---|---|---|
| information_extraction | 85.3% | 92.9% | +7.7pp |
| └ single-session-assistant | 76.8% | 98.2% | **+21.4pp** |
| multi_session_reasoning | 75.2% | 75.2% | +0.0pp |
| temporal_reasoning | 78.2% | 85.0% | +6.8pp |
| knowledge_update | 84.6% | 84.6% | +0.0pp |

## Verdict: **PASS — gate cleared.**
- **Arm A (lift):** SSA +21.4pp (43→55/56), consistent with the Stage-1 SSA-slice canary (+19.6pp, N=3). Decisive, far outside judge noise.
- **Arm B (non-regression):** no category regressed. multi_session and knowledge_update are exactly flat; temporal *improved* +6.8pp (the unconditional fusion helps temporal too — answers often live in specific turns). The feared chunk-lane dilution did not occur.
- **Headline:** 80.81% → **84.43% task-avg** (+3.61pp), 80.60% → **84.80% raw** (+4.20pp).

Corroborated by N=3 SSA-slice canary (Stage 1) and a partial Gemini-API full-500 (temporal/MS/IE all up) before the quota switch to Vertex.

## Ship status
The infra is in `src/` and **validated**, but remains **gated off by default** (env `STRATA_DENSE_TURN_LANE`). Turning it on for real users is a separate **production-graduation** decision (wire `turnStore` into `IncrementalIndexer` + `handleSearchHistory`, embed turns at live index time, flip `useTirQdp`) — that adds a per-turn embedding cost to every user's indexing and is its own spec. This eval validates that the lane is worth graduating.

## Tunables not yet explored (future one-variable iterations vs this frozen baseline)
Query/doc task-type, speaker-prefix on embedded turn text, turn-lane rrfK, Fielded Max-Sim per-speaker scoring, session-NDCG turn-promotion, EMem assistant-response summaries. Each measured one-at-a-time against this `best-score.md`.
