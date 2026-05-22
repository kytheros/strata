# Turn-Lane Ranking — Baseline

**Date:** 2026-05-22
**Commit:** a7f4277 (HEAD before this AutoResearch target was committed)
**Score:** 22/30 (frozen)

## Per-fixture results

| Fixture | Top-1 | Recall@5 | Score | Notes |
|---------|-------|----------|-------|-------|
| ranking-001 | ✓ | ✓ | 2/2 | Port temporal-001. Recency boost correctly surfaces t1sess002 turn 0. |
| ranking-002 | ✗ | ✓ | 1/2 | Port temporal-002. Classifier did not fire on "Is semantic search a Pro feature?" — lacks explicit temporal markers. BM25 puts older session first. |
| ranking-003 | ✓ | ✓ | 2/2 | Port LME-71017276. FTS5 match + recency boost surfaces answer session. |
| ranking-004 | ✓ | ✓ | 2/2 | Port LME-gpt4_59149c77. FTS5 match + recency boost surfaces answer session. |
| ranking-005 | ✓ | ✓ | 2/2 | Port LME-gpt4_fa19884c. FTS5 match + recency boost surfaces answer session. |
| ranking-006 | ✗ | ✓ | 1/2 | Single-session fall-through. Only one session → no recency boost. BM25 ranks the first user turn (alpine) over the later correction turn (debian-slim). |
| ranking-007 | ✗ | ✓ | 1/2 | Three-session gradient. Recency boost fires, newest session at top. But assistant's confirmation turn (turn_index=1) outranks user's decision turn (turn_index=0) in BM25 within same session. |
| ranking-008 | ✗ | ✓ | 1/2 | Same pattern as 007. Assistant confirmation turn ranked first within newest session. |
| ranking-009 | ✗ | ✓ | 1/2 | Historical-query negative. Classifier correctly vetoed recency dominance ("previously" + "before the bump"). But within r9sess001, the assistant's reply (turn_index=1) has higher BM25 than user's original statement (turn_index=0). |
| ranking-010 | ✗ | ✓ | 1/2 | Same-session correction. BM25 ranks the initial mention (turn_index=0, Redis) over the correction (turn_index=2, SQLite). |
| ranking-011 | ✗ | ✓ | 1/2 | Cross-topic noise. "currently" triggered recency dominance; newest session (toolkit admin nav) at rank 1-4 before the relevant older session (rank 5). |
| ranking-012 | ✗ | ✓ | 1/2 | Designed to fail top-1. Recency boost surfaces r12sess002 (Terraform mentions) before r12sess001 (Pulumi decision). Evidence at rank 3. |
| ranking-013 | ✓ | ✓ | 2/2 | Classifier negative. Historical phrasing "the time we discussed" correctly vetoed recency. Older session at rank 1. |
| ranking-014 | ✓ | ✓ | 2/2 | Classifier negative. "the history of" correctly vetoed recency. Older session at rank 1. |
| ranking-015 | ✓ | ✓ | 2/2 | Classifier negative. "when did we first decide" correctly vetoed recency. Older session at rank 1. |

## Sub-2/2 fixtures (8)

**ranking-002:** The query "Is semantic search a Pro feature?" is a question about current state but lacks explicit temporal markers (`now`, `currently`, `latest`, etc.). `isTemporalCurrentStateQuestion()` returns false, so `applyTurnRecencyBoost` is a no-op. BM25 ranks the older session's turn ("Semantic search is a Pro feature") higher due to exact keyword match. Expected: recency boost fires or BM25 alone returns newer session first.

**ranking-006:** Single session — `applyTurnRecencyBoost` no-ops when all hits share the same session (distinctCreatedAts < 2). Within the session, BM25 ranks turn_index=0 ("alpine") higher than turn_index=2 ("debian-slim") because the former has more direct keyword overlap with "strata-mcp Docker image". The correction turn is the semantically correct answer but ranks second.

**ranking-007/008:** Within the newest session, the assistant confirmation turn (turn_index=1) gets a higher BM25 score than the user's decision turn (turn_index=0). The recency boost correctly surfaced the newest session, but within that session the ordering is wrong. Improvement direction: weigh user turns over assistant turns, or use turn_index as a tiebreaker.

**ranking-009:** `hasHistoricalMarker()` correctly fired ("previously", "before the bump"), vetoing recency dominance. Evidence is in r9sess001 (older session). But within that session, turn_index=1 (assistant: "Node 20 is LTS...") has higher BM25 than turn_index=0 (user: "I'm on Node 20..."). The expected evidence is the user turn, not the assistant confirmation.

**ranking-010:** Single session with correction. BM25 ranks turn_index=0 ("Redis", "rate-limit", "token bucket") highest — the initial proposal has high content overlap with the query. The correction turn (turn_index=2, "SQLite") ranks second. Within-session BM25 ordering doesn't account for later corrections overriding earlier proposals.

**ranking-011:** "What answer model does the harness use currently?" — `currently` triggered `isTemporalCurrentStateQuestion()`, which engaged recency dominance. The newest session (toolkit admin nav, r11sess003) has no relevant content but ranks first. The relevant older session (r11sess001, GPT-4o decision) is at rank 5 — just barely in recall@5. Documenting that "current state" queries can fire on irrelevant newest sessions.

**ranking-012 (designed failure):** "What IaC tool are we using now?" — recency boost fires (current-state query), surfacing r12sess002 first. r12sess002 mentions "Terraform" (the old tool under discussion), scoring high on BM25 for a "IaC tool" query. The actual decision turn (r12sess001, Pulumi) is at rank 3. Documented improvement direction: per-turn relevance threshold before applying session dominance.

## Frozen-eval rules

The eval script, corpus, and scoring logic are frozen as of this baseline.
Optimization runs change one variable at a time in src/config.ts or
src/search/*. See spec 2026-05-22-turn-lane-ranking-autoresearch-design.md
section 8 for the discipline.
