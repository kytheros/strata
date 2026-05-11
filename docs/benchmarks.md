# Retrieval Quality Benchmarks

This document describes Strata's retrieval quality benchmark methodology and results. The benchmark compares Strata Community (BM25-only), Strata Pro (hybrid BM25 + vector + RRF), and Mem0 on a standardized corpus of operational engineering knowledge.

---

## Methodology

### Corpus: Operational Learnings

The benchmark uses a curated corpus of 50 operational learnings (`benchmarks/operational-learnings.json`) covering five categories:

| Category | Count | Description |
|----------|-------|-------------|
| `api_behavior` | 10 | API rate limits, response formats, pagination quirks, auth flows |
| `error_pattern` | 10 | Error codes, failure modes, debugging steps, root causes |
| `tool_gotcha` | 10 | CLI flag surprises, version-specific behaviors, silent failures |
| `deployment` | 10 | CI/CD steps, environment configuration, rollback procedures |
| `config` | 10 | Configuration discoveries, default overrides, environment variables |

Each learning is a realistic operational discovery that a software team would encounter during development -- the kind of knowledge that typically lives in tribal memory or gets lost between sessions.

### Test Queries

20 test queries with manually labeled ground-truth relevant learning IDs. Each query is a natural-language question or problem description that a developer might ask.

Queries span different retrieval challenges:
- **Exact keyword match**: queries using the same terms as the corpus entries
- **Semantic similarity**: queries using different phrasing for the same concept
- **Multi-topic**: queries that should match learnings from multiple categories
- **Narrow technical**: queries about specific error codes, API parameters, or config values

### Metrics

| Metric | Definition |
|--------|------------|
| **Recall@5** | Fraction of relevant learnings found in the top 5 results |
| **Recall@10** | Fraction of relevant learnings found in the top 10 results |
| **MRR** (Mean Reciprocal Rank) | Average of 1/rank for the first relevant result across all queries |
| **p50 latency** | Median query latency in milliseconds |
| **p95 latency** | 95th percentile query latency in milliseconds |

### Pipelines Tested

| Pipeline | Description |
|----------|-------------|
| **Strata Community** | Hybrid BM25 + vector cosine similarity merged via Reciprocal Rank Fusion. BM25 full-text search via FTS5 with Porter stemming; vector embeddings via Gemini (3072d) or local provider (384d). Boosts: recency, project match, importance. |
| **Mem0** | Mem0 hosted API with default configuration. Requires `MEM0_API_KEY`. |

> **Note on Strata Pro.** Pro's differentiators — procedures, entity graph, analytics, cloud sync, knowledge audit — don't move retrieval-quality metrics on a 50-learning corpus where Community already saturates Recall@5. Pro warrants its own evaluations on its own axes (procedure-recall, entity-graph traversal, analytics fidelity); those are queued separately. See [Pro feature evaluations](#pro-feature-evaluations) below.

### Comparison set

This benchmark currently reports Strata Community vs Mem0. The intended comparison set also includes **Letta**, **MemGPT**, **Zep**, and **Cognee**; harnesses are queued. Results land here as those harnesses ship.

---

## Reproducibility

### Run Strata-Only Benchmark

```bash
cd strata
npm run benchmark
```

This creates a fresh temporary SQLite database, loads all 50 learnings, runs 20 queries, and outputs metrics as both JSON and a formatted markdown table.

### Run Full Benchmark (including Mem0)

```bash
cd strata
MEM0_API_KEY=your-key npm run benchmark:full
```

The Mem0 benchmark requires a valid API key. If `MEM0_API_KEY` is not set, the Mem0 comparison is skipped gracefully with a message.

### Benchmark Source Files

| File | Description |
|------|-------------|
| `benchmarks/operational-learnings.json` | Corpus: 50 learnings + 20 test queries with ground truth |
| `benchmarks/retrieval-benchmark.ts` | Strata benchmark harness |
| `benchmarks/mem0-benchmark.ts` | Mem0 comparison harness (skeleton) |

---

## Results

Last updated: 2026-04-30

### Summary

| Metric | Strata Community | Mem0 (hosted API) |
|--------|------------------|-------------------|
| **Recall@5** | **1.000** | 0.300 |
| **Recall@10** | **1.000** | 0.300 |
| **MRR** | **1.000** | 0.300 |
| **p50 latency** | **0.3ms** | 302.9ms |
| **p95 latency** | **0.5ms** | 389.9ms |
| Memories stored | 50/50 | 20/50 |

### Strata Community (hybrid BM25 + vector + RRF)

| Metric | Value |
|--------|-------|
| Recall@5 | 1.000 |
| Recall@10 | 1.000 |
| MRR | 1.000 |
| p50 latency | 0.3ms |
| p95 latency | 0.5ms |

All 20 queries returned the correct relevant learning in position 1. BM25 with stop-word stripping and OR matching handles operational keyword queries extremely well; vector retrieval and RRF fusion are available in the same pipeline for queries where exact-match matters less.

### Mem0 (hosted API)

| Metric | Value |
|--------|-------|
| Recall@5 | 0.300 |
| Recall@10 | 0.300 |
| MRR | 0.300 |
| p50 latency | 302.9ms |
| p95 latency | 389.9ms |

#### Key Observations

1. **Data loss via memory compression.** Mem0 stored only 20 memories from 50 submitted learnings. Their graph memory feature performs entity extraction and deduplication, merging distinct operational learnings into condensed nodes. For operational knowledge where each learning is independently valuable, this compression causes 60% data loss.

2. **Duplicate-heavy retrieval.** Search results contained heavy duplication — the same few Mem0 memory IDs appeared repeatedly across results for different queries. Only 6 of the 20 stored memories (L001–L006) accounted for the majority of all retrieved results.

3. **6/20 queries succeeded.** The queries that returned correct results (Q001, Q010, Q011, Q012, Q014, Q019) all targeted learnings that survived Mem0's compression step intact. The other 14 queries targeted learnings that were either merged into unrecognizable composites or lost entirely.

4. **Network latency overhead.** Mem0's hosted API adds ~300ms per query — roughly 1000x slower than Strata's local SQLite queries. This is a structural difference: Strata runs entirely locally with no network round-trip.

---

## Design Decisions

### Why this corpus?

Strata started out as **memory for AI coding assistants** — Claude Code, Codex CLI, Aider, Cline, Gemini CLI. The job was to index those assistants' session history into searchable, recallable knowledge so the next session didn't start cold. The operational-learnings corpus simulates that exact content shape: error codes, config gotchas, deploy steps, tool surprises — the hard-won knowledge a coding assistant accumulates and a teammate would benefit from recalling later.

Operational learnings are:
- **Specific**: they reference concrete tools, versions, error codes, and configurations
- **Actionable**: they describe what to do (or avoid) in specific situations
- **Discoverable via keywords**: they contain technical terms that BM25 handles well

This domain plays to Strata's strengths (FTS5 exact-match + quality-gated ingestion) while also testing semantic retrieval on queries that use different phrasing.

The product itself has since grown beyond coding assistants. Strata exposes a REST API and Python SDK that any agent can use as a memory backend, and ships a world-scoped storage path for game-engine NPCs. Those tracks have their own evaluations because the content shape and access patterns differ — see [NPC memory evaluations](../evals/npc-recall-tir-qdp/README.md) and the LongMemEval results referenced from the project README. This benchmark is specifically the coding-assistant-memory story.

### Why BM25 Matters for Operational Knowledge

For operational queries containing specific technical terms (error codes, API names, configuration keys), BM25 exact-match search often outperforms pure vector search. A query for "ECONNREFUSED port 5432" benefits more from exact keyword matching than from semantic similarity.

Strata Pro's hybrid pipeline combines both: BM25 catches exact matches while vector search finds semantically related content. The RRF fusion gives credit to results that appear in either list, with bonus scoring for results found by both methods.

### Latency Advantage

Strata runs entirely locally with SQLite. There is no network round-trip for queries. This gives Strata a structural latency advantage over hosted API services like Mem0, especially for the p50 metric.

---

## Other evaluation tracks

The operational-learnings benchmark above tests retrieval quality on the coding-assistant-memory use case. Strata also has two other evaluation tracks targeting different content shapes and access patterns.

### LongMemEval

[LongMemEval](https://arxiv.org/abs/2410.10813) is the standard academic benchmark for long-term conversational memory — multi-session question answering where a system must recall and reason over facts spread across many prior conversations.

| Metric | Value |
|--------|-------|
| **Task-averaged accuracy (LongMemEval-500)** | **81.1%** |
| Answer model | GPT-4o (`gpt-4o-2024-08-06`) |
| Judge model | GPT-4o |
| Extraction provider | Gemini 2.5 Flash |
| Run date | 2026-03-27 |

The 500-question run uses the official LongMemEval split, the published evaluation rubric, and the same answer/judge models referenced in the upstream paper for direct comparability. Strata's retrieval pipeline (the same hybrid BM25 + vector + RRF that ships in Community) is wrapped in an agent loop with a 40K-token budget per question.

Reproducibility: see `evals/longmemeval/` in this repository for the harness, the wrapper-prompt templates, and the run logs.

#### TIR+QDP Delta — LongMemEval Q50 stratified (2026-05-11, partial)

Re-run of the prior Q50 experiment after three caveats from the original `bb28f2b` run were resolved: answer model fixed to GPT-4o (per `feedback_longmemeval_gpt4o.md`), question subset stratified across all 5 LongMemEval abilities, and Gemini embedder hardened with retry-on-5xx. The re-run was halted after 4 of 6 planned runs (3 flag=off + 1 flag=on) because the flag=on run showed a clear regression versus flag=off, in the opposite direction from the original `bb28f2b` result.

**Harness:** `benchmarks/longmemeval-tirqdp-baseline.ts --qset-strategy stratified --answer-model gpt-4o-2024-08-06` (kytheros/strata#5)
**Answer model:** `gpt-4o-2024-08-06` (project convention; comparable to published 81.1% baseline)
**Judge model:** `gpt-4o-2024-08-06`
**Gemini embeddings:** Clean. Zero retry events observed in any of the 4 runs after the `f20f142` embedder retry fix landed.
**Stratification:** `--qset-strategy stratified` selected 10 questions per ability across 4 abilities (Q50 returned 40 because `abstention` had 0 questions available in the head of the dataset).

| Run | Flag | Task-avg | Raw |
|-----|------|----------|-----|
| 1 | off | 42.5% | 17/40 |
| 2 | off | 37.5% | 15/40 |
| 3 | off | 40.0% | 16/40 |
| 4 | on  | 32.5% | 13/40 |

| Side | Mean | SD | N runs |
|------|------|-----|--------|
| flag=off | **40.0%** | 2.5 pp | 3 |
| flag=on | **32.5%** | — | 1 |
| **Delta** | **−7.5 pp** | | |

**Per-ability breakdown (each ability has N=10 questions per run; flag=off averaged over 3 runs):**

| Ability | flag=off | flag=on | Delta |
|---------|----------|---------|-------|
| Information Extraction | 30% | 30% | **0 pp** |
| Multi-Session Reasoning | 47% | 30% | **−17 pp** |
| Temporal Reasoning | 63% | 30% | **−33 pp** |
| Knowledge Update | 20% | 40% | **+20 pp** |
| Abstention | — | — | (no Qs in subset) |

**Verdict:** TIR+QDP is **not** a uniform retrieval win. Stratified data shows it helps `knowledge_update` substantially (+20 pp) but hurts `temporal_reasoning` (−33 pp) and `multi_session_reasoning` (−17 pp). The original `bb28f2b` +22.7 pp result was an artifact of two issues now resolved: (a) the Q50 subset was 100% `information_extraction`, the one ability where TIR+QDP either ties or modestly helps; (b) Claude Sonnet was bad at single-session questions without TIR+QDP, so the gain there inflated when measured with Sonnet — GPT-4o doesn't need TIR+QDP for that ability (flat 30%/30% here).

**`useTirQdp` should NOT be default-true.** The flag remains a per-query opt-in until per-ability gating is designed or the temporal/multi-session regressions are root-caused.

**Why we stopped at 4/6 runs:** the ticket's halt criterion is `flag=on mean ≤ flag=off mean`. Run 4 alone gave a 7.5 pp regression — adding 2 more `flag=on` runs would tighten the SD but not change the direction, and the per-ability deltas (especially −33 pp on temporal reasoning) are unambiguous at N=10 questions per ability. Continuing would have cost ~$10-15 in OpenAI calls without changing the verdict. Issue #5 stays open pending root-cause investigation into the temporal/multi-session regressions.

**Caveats on this Q50 partial data:**

- `flag=on` is N=1 run; mean SD unmeasured. Per-ability deltas at N=10 questions each are directional but not statistically tight.
- `abstention` ability is unmeasured (no questions in the stratified head).
- Q500 might shift any individual ability delta, but the catastrophic −33 pp on temporal reasoning is unlikely to flip at scale.
- The 40% off-baseline is well below the 81.1% published number — the gap is the Q40 stratified subset being a harder slice than the full Q500 mix, not an evaluation bug.

**Next: investigate before any further Q500 spend.** Root-cause why TIR+QDP regresses temporal and multi-session before running the more expensive Q500. Candidate hypotheses: (1) the turn-level fusion is pulling in too much noise from older sessions for temporal queries; (2) `recallQdpCommunity` filtering is wrong for cross-session reasoning. Add per-ability flag gating once the regression mechanism is understood.

Result files: `benchmarks/longmemeval/results/tirqdp-baseline-{off,on}-50-2026-05-11T18-*.json` (4 files, gitignored)

### NPC memory evaluations

The game-engine track evaluates Strata's REST + world-scoped storage path on multi-turn dialogue with NPCs (Spec 2026-04-28: NPC Conflict Resolution).

**Frozen retrieval eval** — 16 hand-curated scenarios covering retrieval correctness, conflict-resolution correctness, and abstention. Deterministic, LLM-free.

| Metric | Value |
|--------|-------|
| Score | **16/16** |
| Date | 2026-04-30 |

**Stress battery** — 10 end-to-end multi-turn dialogue tests exercising contradiction handling, alias chains, abstention, and long-context recall against a live NPC dialogue model.

| Run config | Pass rate (N=3 avg) | Stable failures |
|---|---|---|
| Tier-1-tuned Ollama + drain-wait gate | **7.0 / 10** | NoiseBuriedFact, PrivateSecretPreserved, AbstentionWithPollutedContext |

The two tests Spec 2026-04-28 was designed to fix — `ContradictoryUpdate` (Silvermist→Shadowfax) and `ConflictingQuantities` — pass in 5 of 6 attempts across N=1 and N=3 runs. The stable-failure set is generation-side (LLM prompt-following), not retrieval; each is queued for its own spec.

Reproducibility: see `evals/npc-recall-tir-qdp/` (frozen eval) and `evals/npc-recall-tir-qdp/stress-battery-ab.md` (stress battery readouts).

---

## Pro feature evaluations

Strata Pro extends the open-source memory engine with features that don't show up on a retrieval-quality benchmark: procedures (reusable search recipes), entity graph (cross-memory entity tracking), analytics (`get_analytics`, `knowledge_stats`, `knowledge_quality`, `knowledge_audit`, `list_evidence_gaps`), cloud sync, and conversation-level ingestion.

These features warrant their own evaluations on their own axes:

| Feature | Evaluation axis | Status |
|---|---|---|
| Procedures | Procedure recall and reuse hit-rate | Queued |
| Entity graph | Cross-memory entity-traversal queries | Queued |
| Analytics | Aggregate fidelity vs ground truth | Queued |
| Cloud sync | Multi-device convergence + conflict resolution | Queued |

Results land here as those harnesses ship.
