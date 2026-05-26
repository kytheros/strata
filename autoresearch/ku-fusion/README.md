# autoresearch/ku-fusion

Frozen eval gating the B2 KU-gated turn-lane fusion experiment.

## What this eval measures

Task-averaged answer accuracy on the 78 LongMemEval questions whose
`question_type === "knowledge-update"`. Identical config to the 2026-03-27
500Q baseline (Gemini 2.5 Flash answer + GPT-4o judge, topK=20, category
prompt), restricted via `--ids` to the KU slice.

## Variants

The fusion mode is controlled by `STRATA_KU_FUSION_MODE` (or
`CONFIG.benchmark.kuFusion.mode`):

- **off** — chunk-lane only. The 2.3.0 baseline.
- **append** — M1: append chunks from turn-lane sessions not in chunk-lane
  top-20 (up to `maxAppend=5` extras).
- **rrf** — M2: RRF-fuse chunk-lane + turn-lane session ranks at `rrfK=60`,
  resort, keep top (20 + maxAppend).

## Ship gate

≥ +3pp absolute over baseline (= 69/78 = 88.46%). No variant ships
automatically; the experiments/ ledger records each variant's number
and a decision (keep / discard).

## Frozen eval — DO NOT modify

The slice IDs are derived from `benchmarks/longmemeval/data/longmemeval_oracle.json`
at runtime (filter where `question_type === "knowledge-update"`). The
oracle file is the source of truth; do not edit it as part of any
tuning iteration.

## How to run

```bash
cd strata
STRATA_KU_FUSION_MODE=off    npx tsx autoresearch/ku-fusion/run-eval.ts
STRATA_KU_FUSION_MODE=append npx tsx autoresearch/ku-fusion/run-eval.ts
STRATA_KU_FUSION_MODE=rrf    npx tsx autoresearch/ku-fusion/run-eval.ts
```

Each run takes 30–60 minutes (Gemini-quota-bound).

Requires `GEMINI_API_KEY` (answer) + `OPENAI_API_KEY` (judge) in `strata/.env`.

### Smoke test (3 questions, no Gemini quota burned)

```bash
cd strata
STRATA_KU_FUSION_SMOKE_IDS="$(npx tsx -e "const d=require('fs').readFileSync('benchmarks/longmemeval/data/longmemeval_oracle.json','utf8');const q=JSON.parse(d).filter(x=>x.question_type==='knowledge-update').slice(0,3).map(x=>x.question_id);console.log(q.join(','))")" \
  STRATA_KU_FUSION_MODE=off npx tsx autoresearch/ku-fusion/run-eval.ts
```

## Spec

`specs/2026-05-26-b2-ku-fusion-design.md`
