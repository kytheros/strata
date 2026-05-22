# Turn-Lane Ranking — Corpus

15 fixtures conforming to the `evals/distillation-e2e/fixtures/*.json` schema.

## Provenance

| # | Source | Pattern |
|---|---|---|
| 001 | port from `evals/distillation-e2e/fixtures/hand-annotated/temporal-001.json` | Multi-session newer-vs-older (Node 20 → 22) |
| 002 | port from `evals/distillation-e2e/fixtures/hand-annotated/temporal-002.json` | Multi-session status update (semantic search Pro → Community) |
| 003 | port from `evals/distillation-e2e/fixtures/longmemeval-borrowed/lme-71017276.json` | LME episodic query, synthetic timestamps added (session N → 1700000000000 + N×86400000) |
| 004 | port from `evals/distillation-e2e/fixtures/longmemeval-borrowed/lme-gpt4_59149c77.json` | LME episodic query, synthetic timestamps added |
| 005 | port from `evals/distillation-e2e/fixtures/longmemeval-borrowed/lme-gpt4_fa19884c.json` | LME episodic query, synthetic timestamps added |
| 006 | new — single-session fall-through | One session, three turns, latest is the answer (Docker base image) |
| 007 | new — three-session recency gradient (Postgres versions) | Three sessions, gradient over days |
| 008 | new — three-session recency gradient (Ubuntu runner images) | Tighter time gap, same shape as 007 |
| 009 | new — historical-query negative | Same corpus as 001; query asks for the OLDER state ("previously") |
| 010 | new — same-session correction | One session, user changes their mind mid-stream (Redis → SQLite) |
| 011 | new — cross-topic noise | Three sessions, only the oldest contains the answer; "currently" triggers recency boost |
| 012 | new — newer-session-noise vs older-session-signal | Documented improvement room — fails top-1 by design (Pulumi vs Terraform) |
| 013 | new — classifier negative ("tell me about the time we discussed") | Historical phrasing despite recent topic |
| 014 | new — classifier negative ("what's the history of") | Explicit history keyword |
| 015 | new — classifier negative ("when did we first decide") | First/decided phrasing |

## What each pattern stresses

- **Single-session fall-through (006):** Recency dominance must skip; BM25 ordering preserved.
- **Three-session gradient (007, 008):** Newest session at rank 1; older sessions in top-5.
- **Historical-query negative (009):** `hasHistoricalMarker()` must veto `isTemporalCurrentStateQuestion()`.
- **Same-session correction (010):** Latest turn within a single session ranks first.
- **Cross-topic noise (011):** Relevant older session surfaces in top-5 despite irrelevant newer sessions.
- **Newer-noise vs older-signal (012):** Documents ranker limitation — improvement room.
- **Classifier negatives (013–015):** Router must NOT engage recency dominance on historical phrasing.

## LME fixture notes

Fixtures 003–005 are ported from LongMemEval. They have 46–49 sessions each with
personal episodic content (not coding conversations). `created_at` timestamps are
synthetic (session N → `1700000000000 + N * 86400000`). The answer sessions
(`answer_*`) are near the end of the session list and score well at baseline
because FTS5 content matching surfaces them in the top-20 results.
