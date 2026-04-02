# LOCOMO Benchmark for Strata

Evaluates Strata's memory quality against the [LOCOMO](https://arxiv.org/abs/2402.17753) benchmark using the [MemEval](https://github.com/ProsusAI/MemEval) harness -- the standardized evaluation framework for AI memory systems.

## Quick Start

```bash
# 1. Create venv and install deps
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 2. Smoke test (1 conversation, no judge)
GEMINI_API_KEY=xxx ./run.sh --num-samples 1 --skip-judge

# 3. Full run with judge (~$50)
GEMINI_API_KEY=xxx OPENAI_API_KEY=xxx ./run.sh
```

Or use `run.sh` which handles venv creation automatically.

## Environment Variables

| Variable | Purpose | Required? |
|----------|---------|-----------|
| `GEMINI_API_KEY` | Answer model (Gemini 2.5 Flash) + Strata embeddings | Yes |
| `OPENAI_API_KEY` | Judge model (gpt-5.2) | For publishable run |
| `JUDGE_MODEL` | Override MemEval judge | Optional (default: gpt-5.2) |
| `STRATA_DATA_DIR` | Base dir for per-conversation DBs | Optional (default: temp dir) |
| `STRATA_ANSWER_MODEL` | Override answer model | Optional (default: gemini-2.5-flash) |

## Answer Model

Gemini 2.5 Flash ($0.30/$2.50 per 1M tokens) -- consistent with our LongMemEval benchmark.

## Results

Two scores reported per run:
- **Full** (all 1,986 QA pairs) -- MemEval leaderboard comparable
- **Non-adversarial** (~1,540 QA pairs) -- Honcho comparable

## Requires Strata Pro

This benchmark uses `strata-pro` (not the free community edition) because it needs `ingest_conversation` — the Pro tool that runs the full extraction pipeline (chunking, FTS5 indexing, knowledge extraction, entity extraction, embeddings). The community `store_memory` tool stores raw text but does not chunk or index it for search, resulting in 0% retrieval accuracy on LOCOMO.

This is a meaningful feature gap: **community users cannot run memory benchmarks** against standardized datasets. The full extraction pipeline is a Pro-only capability.

## Architecture

```
MemEval Harness (Python)
  +-- strata_adapter.py       <-- Strata adapter
  |     +-- StrataClient (stdio transport)
  |           +-- npx strata-pro (subprocess)
  +-- _qa_results (MemEval)   <-- handles scoring
  +-- Judge (gpt-5.2)         <-- 3-dimensional scoring
```

Each of LOCOMO's 10 conversations gets its own isolated Strata database, simulating real per-user deployment where each user has their own Strata instance.
