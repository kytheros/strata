# TIR+QDP Upgrade Guide

TIR+QDP (Turn-level Indexing and Retrieval + Query-Driven Pruning) is an improved retrieval mode that indexes conversation turns individually before merging them into knowledge chunks, then prunes candidate results to only those whose turn-level evidence directly answers the query. In practice this improves recall on buried-fact questions, long-session distractor saturation, and redundancy-heavy corpora — the patterns that matter most for multi-session AI coding memory.

## Status: opt-in early access

TIR+QDP is **off by default** in this release. It will flip to default-on in a future release after the current dogfooding period. Opting in now gives you improved retrieval ahead of the general flip and lets you report issues before they affect everyone.

## Two-step opt-in

### Step 1 — Populate the `knowledge_turns` table

```bash
strata index --rebuild-turns
```

This reads your existing session files and populates the `knowledge_turns` table from them. On a 100K-turn corpus this takes a few minutes. Progress is printed as it runs. The command is **idempotent** — you can run it again safely; existing turns for each session are replaced (delete-then-reinsert, per session).

Optional flags:

| Flag | Description |
|------|-------------|
| `--project <name>` | Limit indexing to one project instead of the full corpus |
| `--dry-run` | Print what would be indexed without writing anything |

### Step 2 — Enable the turn lane in search

```bash
strata config set search.useTirQdp true
```

Once set, `search_history`, `find_solutions`, and `semantic_search` will route queries through the turn-level retrieval lane in addition to the existing chunk lane. Results from both lanes are fused via Reciprocal Rank Fusion — the existing ranking stack is unchanged, this is an additive lane.

No MCP client restart is needed. The config change takes effect on the next tool call.

## Rollback

```bash
strata config set search.useTirQdp false
```

This reverts to the pre-TIR+QDP retrieval path immediately. The `knowledge_turns` table stays populated but is not read. There is no data loss — re-enabling TIR+QDP later does not require re-running `strata index --rebuild-turns`.

## What changes with TIR+QDP enabled

**Improved:** recall on long-session conversational queries. The three failure patterns TIR+QDP targets are:

- **Buried-fact** — a key fact mentioned once in a long session that chunk-level indexing buries under surrounding context
- **Distractor saturation** — repeated near-miss content that pushes the true answer down the ranking
- **Redundancy** — many chunks covering the same topic, diluting the score of the single chunk that actually answers the question

**Neutral to slightly positive:** existing operational-knowledge queries (decisions, solutions, error fixes). These are typically dense, self-contained entries that chunk-level indexing already handles well.

## What does not change

**Request/response shapes for all MCP tools are unchanged.** `search_history`, `find_solutions`, and `semantic_search` accept the same parameters and return the same schema. The only new field is an optional `source` annotation on individual results:

```
source: "turn" | "chunk"
```

This field is additive and optional — existing callers that do not inspect it are unaffected.

## Verifying the setup

After completing both steps, run a quick sanity check:

```bash
strata search "any query you know should surface something"
```

If results include entries annotated with `source: "turn"`, TIR+QDP is active. You can also check `strata status` — it will report the `knowledge_turns` row count alongside the existing `knowledge_entries` count.

## Reporting issues

If you observe a regression in retrieval quality with TIR+QDP enabled, please open an issue at [github.com/kytheros/strata/issues](https://github.com/kytheros/strata/issues) with:

1. The query that regressed
2. `strata status` output
3. Whether `search.useTirQdp` is `true` in `~/.strata/config.json`

Disabling TIR+QDP (`strata config set search.useTirQdp false`) is always a safe immediate rollback.
