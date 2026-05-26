# Baseline — autoresearch-ku-fusion

**Frozen as of:** 2026-05-26
**Source:** `benchmarks/longmemeval/data/results-full-topk20-session-rerank-onnx-events-top9999-2026-03-27T14-50-31-628Z.json`

## Score

| Ability | Score | % |
|---|---|---|
| knowledge_update | 66/78 | **84.62%** |

This is the per-ability slice from the 81.08% full-500Q baseline (Gemini
answer + GPT-4o judge, topK=20, category prompt, no fusion). The B2
fusion experiment compares each variant's KU accuracy against this 84.62%
floor.

## Models

- Answer: `gemini-2.5-flash`
- Judge: `gpt-4o-2024-08-06`
- Retrieval: topK=20, ONNX session reranker, events-top9999, category prompt

## Why this baseline

KU accuracy is the most direct measure of whether the +7.05pp recall
lift (from the corrected sessionScoring=true measurement,
`turn-lane-lift-fts5-2026-05-26T18-57-08-022Z.json`) translates to the
answer model getting more KU questions right. If the answer model can
already produce the correct answer with chunk-lane context, recall lift
won't move accuracy — that's a key finding too.
