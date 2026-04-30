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
| **Strata Community** | BM25 full-text search via FTS5 with Porter stemming. Boosts: recency, project match, importance. |
| **Strata Pro** | Hybrid BM25 + vector cosine similarity (Gemini 3072d or local 384d) merged via Reciprocal Rank Fusion (k=60). Same boosts as community. |
| **Mem0** | Mem0 hosted API with default configuration. Requires `MEM0_API_KEY`. |

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

Last updated: 2026-03-13

### Summary

| Metric | Strata Community (BM25) | Mem0 (hosted API) |
|--------|-------------------------|-------------------|
| **Recall@5** | **1.000** | 0.300 |
| **Recall@10** | **1.000** | 0.300 |
| **MRR** | **1.000** | 0.300 |
| **p50 latency** | **0.3ms** | 302.9ms |
| **p95 latency** | **0.5ms** | 389.9ms |
| Memories stored | 50/50 | 20/50 |

### Strata Community (BM25-only)

| Metric | Value |
|--------|-------|
| Recall@5 | 1.000 |
| Recall@10 | 1.000 |
| MRR | 1.000 |
| p50 latency | 0.3ms |
| p95 latency | 0.5ms |

All 20 queries returned the correct relevant learning in position 1. BM25 with stop-word stripping and OR matching handles operational keyword queries extremely well.

### Strata Pro (hybrid BM25 + vector + RRF)

| Metric | Value |
|--------|-------|
| Recall@5 | _pending — requires embedding provider during benchmark_ |
| Recall@10 | _pending_ |
| MRR | _pending_ |
| p50 latency | _pending_ |
| p95 latency | _pending_ |

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
