# AutoResearch — Dense Turn-Lane (single-session-assistant)

**Spec:** `specs/2026-06-02-dense-turn-lane-design.md`

Measures whether the dense turn-lane (per-turn vector embeddings + FTS5/vector
RRF in `searchTurns` + unconditional result-granularity fusion in `retrieve.ts`)
lifts **single-session-assistant (SSA)** answer accuracy without regressing the
other categories.

## Arms
- **Arm A (lift):** SSA slice accuracy (from `perQuestion`, filtered by
  `questionType === "single-session-assistant"`), dense lane ON vs OFF.
- **Arm B (non-regression):** every other ability (information_extraction's
  non-SSA siblings aggregate, multi_session_reasoning, temporal_reasoning,
  knowledge_update, abstention) ON vs OFF — must stay flat within judge noise.

## Run
```
STRATA_DENSE_TURN_LANE=off npx tsx autoresearch/ssa-dense-turn-lane/run-eval.ts
STRATA_DENSE_TURN_LANE=on  npx tsx autoresearch/ssa-dense-turn-lane/run-eval.ts
```
For a shipped number use **N>=3** (judge noise ~2pp; SSA denominator = 56, small):
```
STRATA_DENSE_TURN_LANE=on npx tsx benchmarks/longmemeval/run-canary.ts --runs=3 \
  --top-k=20 --prompt=category --session-scoring --reranker=onnx --events --judge-votes=3 --run-id=ssa-dtl-on
```

## Ship gate
The dense lane is promoted to a default-on benchmark config only if, across N>=3:
1. **Arm A SSA accuracy improves by a stable margin** (not a single-run swing — a
   2–3 question SSA swing is inside GPT-4o judge noise), AND
2. **Arm B shows no category regression beyond noise.**
Otherwise: log the negative finding in `experiments/`, keep `enabled:false` /
`mode:"off"`, and do not merge into a default-on path.

## Frozen
Do not edit `run-eval.ts` or the dataset during tuning. Tunables (task-type,
speaker-prefix, turn rrfK, quantization) are changed ONE at a time in `src/`
and re-measured here.
