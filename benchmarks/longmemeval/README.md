# LongMemEval Benchmark for Strata

Evaluates Strata's retrieval quality against the [LongMemEval](https://arxiv.org/abs/2410.10813) benchmark (ICLR 2025) — the standard evaluation for long-term memory in AI chat assistants.

## Quick Start

```bash
# 1. Download the dataset (~115K tokens, ~40 sessions per question)
npm run benchmark:longmemeval:download

# 2. Run retrieval-only benchmark (no API key needed, ~15 seconds)
npm run benchmark:longmemeval:retrieval

# 3. Run full benchmark with answer generation + judging (~20 minutes)
ANTHROPIC_API_KEY=xxx npm run benchmark:longmemeval

# 4. Run with a limit for smoke testing
npx tsx benchmarks/longmemeval/run-benchmark.ts --limit=5
```

## What LongMemEval Tests

500 human-curated questions testing 5 memory abilities:

| Ability | Tests |
|---|---|
| Information Extraction | Recall specific details from distant history |
| Multi-Session Reasoning | Synthesize facts spread across sessions |
| Temporal Reasoning | Use time cues correctly |
| Knowledge Updates | Track changes, overwrite stale facts |
| Abstention | Refuse when info is genuinely unknown |

## Two-Phase Scoring

**Phase 1 — Retrieval** (no LLM needed): Does Strata's search find the correct evidence sessions? Metrics: Evidence Recall@K, MRR.

**Phase 2 — End-to-End** (requires API key): Can an LLM answer correctly using Strata's retrieved context? Scored by an LLM judge. Produces scores comparable to published results.

## Published Scores

All scores on LongMemEvalS using GPT-4o as judge unless noted.

| System | Score | Architecture |
|---|---|---|
| OMEGA | 95.4% | SQLite + FTS5 + vector |
| Mastra | 94.87% | Observer + Reflector agents |
| Hindsight | 91.4% | TEMPR + CARA |
| Supermemory | 85.2% | Relational versioning + hybrid |
| Zep/Graphiti | 71.2% | Knowledge graph |
| Mem0 | ~66.9% | API platform |
| Full-context GPT-4o | 60.6% | Brute force 115K context |

## Judge Models

The official LongMemEval eval uses GPT-4o (`gpt-4o-2024-08-06`). This implementation supports:

- **Claude Sonnet 4** (default) — Higher human-agreement kappa (0.768) than GPT-4o (0.728) per the "Judge's Verdict" study. Prompts adapted per [Anthropic's eval best practices](https://docs.anthropic.com/en/docs/test-and-evaluate/develop-tests): reasoning in `<thinking>` tags, verdict in `<result>` tags.
- **Gemini 2.5 Flash** (fallback) — Free tier, existing API key. 0.777 kappa.

Since published scores use GPT-4o, scores from alternative judges should be reported with the judge model noted. Run the calibration study to quantify inter-judge agreement:

```bash
ANTHROPIC_API_KEY=xxx GEMINI_API_KEY=yyy npm run benchmark:longmemeval:calibrate
```

## Multi-Vote Judging (recommended for any "real" run)

```bash
LONGMEMEVAL_ANSWER_MODEL=vertex:gemini-2.5-flash \
  npx tsx benchmarks/longmemeval/run-benchmark.ts \
  --judge-votes=3 \
  --top-k=20 --prompt=category --session-scoring --reranker=onnx --events
```

The judge is called 3× per question and the majority verdict is taken.
Costs ~3× the judge spend (~$3-5 added to a 500Q run); collapses ~half of
the per-question verdict variance observed in the 2026-05-29 investigation.

## Canary-N (recommended for paper-grade or shipped results)

```bash
npx tsx benchmarks/longmemeval/run-canary.ts --runs=3 --judge-votes=3 \
  LONGMEMEVAL_ANSWER_MODEL=vertex:gemini-2.5-flash \
  --top-k=20 --prompt=category --session-scoring --reranker=onnx --events
```

Runs the benchmark 3 times, reports mean ± std-dev of task-avg, and
classifies each question as stable (same verdict across all runs) or
unstable (flipped at least once). Use this before publishing any
benchmark number.

## Why N>=3?

The GPT-4o judge has measurable nondeterminism — even at temperature 0,
floating-point batch effects in the OpenAI backend produce different
verdicts on essentially-identical predicted answers. On a 500Q run, 0.5-1pp
of single-run delta is fully attributable to judge variance. Two single
runs of mode=off vs mode=rrf showed 8 verdict flips, of which ~4 were
judge noise rather than real model behavior changes.

Always prefer multi-vote + canary over deeper single-run analysis when
you need to call a small delta real. See
`specs/2026-05-29-eval-methodology-judge-noise-design.md` for the empirical
basis.

## Environment Variables

| Variable | Purpose | Required? |
|---|---|---|
| `OPENAI_API_KEY` | GPT-4o for judge scoring (comparable to published scores) | Recommended |
| `ANTHROPIC_API_KEY` | Claude Sonnet 4 for answer generation | One of these |
| `GEMINI_API_KEY` | Gemini 2.5 Flash fallback / calibration | for answers |
| `LONGMEMEVAL_ANSWER_MODEL` | Override answer model (e.g., `vertex:gemini-2.5-flash`) | Optional |
| `LONGMEMEVAL_JUDGE_MODEL` | Override judge model (e.g., `claude-sonnet-4`) | Optional |
| `LONGMEMEVAL_JUDGE_VOTES` | Default judge vote count (CLI flag wins if set) | Optional |
| `STRATA_KU_FUSION_MODE` | `off` (default), `append`, or `rrf` for B2 KU fusion | Optional |
| `VERTEX_PROJECT_ID` | GCP project for Vertex routing | Optional |
| `GOOGLE_APPLICATION_CREDENTIALS` | Service account JSON path | Optional |

**For comparable scores**: Set `OPENAI_API_KEY` (judge) + `ANTHROPIC_API_KEY` (answers). The judge defaults to GPT-4o (`gpt-4o-2024-08-06`) — the exact model used by the official LongMemEval eval script and all published results.

## Known Caveats

- B2 KU fusion (`STRATA_KU_FUSION_MODE=rrf`) did **not** generalize at
  500Q scale. Default-off in production. See `specs/2026-05-26-b2-ku-fusion-design.md`.
- Vertex `gemini-2.5-flash` and AI Studio `gemini-2.5-flash` may resolve
  to slightly different snapshots — ~2pp delta observed (Vertex below).
  Use canary-N to disambiguate platform vs model effects.

## CLI Flags

| Flag | Default | Purpose |
|---|---|---|
| `--variant=s\|m` | `s` | LongMemEvalS (~115K tokens) or M (~1.5M tokens) |
| `--retrieval-only` | off | Skip answer generation + judging |
| `--limit=N` | all | Run only first N questions (smoke testing) |
| `--top-k=N` | 20 | Sessions retrieved per question |
| `--prompt=category` | chain-of-note | Prompt variant |
| `--session-scoring` | off | Score session-level retrieval (recommended) |
| `--reranker=onnx` | none | Reranker (`none`, `onnx`, `cohere`) |
| `--events` | off | Include extracted SVO events |
| `--agent-loop` | off | Iterative tool-calling answer mode |
| `--judge-votes=N` | 1 | Number of judge calls per question (recommended 3) |
| `--two-pass` | off | Two-pass answer generation for counting/duration |

## Dataset

Downloaded from [HuggingFace](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned). Stored in `data/` (gitignored). Each question has its own haystack of ~40 conversation sessions.

## Citation

```bibtex
@inproceedings{wu2025longmemeval,
  title={LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory},
  author={Wu, Di and Wang, Hongwei and Yu, Wenhao and Zhang, Yuwei and Chang, Kai-Wei and Yu, Dong},
  booktitle={ICLR},
  year={2025}
}
```
