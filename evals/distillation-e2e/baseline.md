# Distillation E2E Harness — Baseline Reference

This file is the reference baseline for all future harness runs. Updates here
should be treated like AutoResearch frozen-eval changes: any movement against
this baseline is a regression or improvement worth investigating.

---

## T17 — Gemini baseline (v1, locked 2026-05-17)

The locked baseline is the single-shape, turn-lane configuration. Provider
comparison (T18) was intentionally deferred — see "Why v3 was abandoned" below.

### Configuration

- **Git SHA:** `024dfd2`
- **Provider:** `STRATA_EXTRACTION_PROVIDER=gemini`
- **Extraction:** `skipExtraction: true` — turns are written directly to
  `knowledge_turns` (T9.5); the LLM extraction lane is bypassed
- **Retrieval:** `handle.knowledgeTurn.searchByQuery()` — pure FTS5 BM25 over
  raw turns, no decomposition / no reranking / no RRF
- **Answer model:** `gpt-4o-2024-08-06`
- **Judge model:** `gpt-4o-2024-08-06`
- **N:** 1 (no averaging)
- **Per-fixture isolation:** yes — each fixture gets its own `withIsolatedStrata`
- **Retrieval config hash:** `4524e19a9a49`
- **Run record:** `evals/distillation-e2e/runs/2026-05-17T17-28-34-826Z-024dfd2.json`

### Scores

| Metric | Value |
|---|---|
| Wall | **56.8 seconds** |
| Answer accuracy (overall) | **66.7%** |
| Recall@10 (overall) | **100%** |
| Cost | <$1 (GPT-4o only; no extraction calls) |

### Per failure mode (hand-annotated, 2 fixtures each)

| Mode | Score | Notes |
|---|---|---|
| code_identifier | 1.00 | |
| compound | 1.00 | |
| coreference | 1.00 | |
| hedge | 1.00 | |
| long_context | 1.00 | |
| negation | 1.00 | |
| **temporal** | **0.50** | 1 of 2 fails — Node 20 wins over Node 22 in BM25; no recency signal |
| tool_output_buried | 1.00 | |

### Per LongMemEval task type

| Task type | Score |
|---|---|
| ie (information extraction) | 0.80 |
| ku (knowledge update) | 0.60 |
| temporal | **0.00** |
| multi_session | 0.40 |

### Known limitations

- **Single retrieval shape.** All fixtures go through `knowledge_turns` BM25.
  Different failure modes need different shapes (recency-weighted for temporal,
  graph/aggregate for multi_session, knowledge_entries for ie). v2 of the
  harness will be shape-aware.
- **Extraction-quality is not measured.** Because we use the turn lane,
  provider extraction differences (Gemini vs Gemma) don't affect the score.
  T18 was deferred for this reason.
- **GPT-4o answer + judge introduce some run-to-run variance** even at
  `temperature: 0`. Treat single-fixture deltas below ~0.05 as noise.
- **No reranker, no RRF, no TIR+QDP.** The Intelligent Retrieval Router
  (`kytheros/strata#13`) is not exercised.

### Why v3 (extraction enabled) was abandoned

We initially ran T17 with `skipExtraction: false` (v3) to compare extraction
providers. Result: identical scores (63.9% vs v2's 66.7% — within GPT-4o
noise floor) at 271× the wall time (4.3 hr vs 57 sec). Diagnosis: with T9.5
wired, `query-runner` consults `knowledge_turns` only, so extracted
`knowledge_entries` summaries don't enter the answer's evidence. The lane
where extraction matters isn't queried.

**Implication:** the current harness cannot differentiate extraction
providers via final answer accuracy. T17 v3 + T18 are blocked behind a
shape-aware harness redesign. See
`specs/2026-05-18-distillation-e2e-harness-v2-design.md`.

### Pass thresholds (deferred to harness v2)

The original spec defined ≥0.85× / ≥0.90× / ≤2× thresholds for Gemma 4 vs
Gemini answer / recall / wall. Those gates are paused until v2 of the
harness exists.
