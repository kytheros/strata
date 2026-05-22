# Experiment 000 — Baseline

**Date:** 2026-05-22
**Variable changed:** none — initial baseline measurement
**Score:** 22/30
**Delta from prior:** N/A

## Raw run output

```
Loaded 15 fixtures from E:\strata\strata\autoresearch\turn-lane-ranking\fixtures

ranking-001  score=2/2 top1=✓ recall5=✓ rank=1
ranking-002  score=1/2 top1=✗ recall5=✓ rank=2
ranking-003  score=2/2 top1=✓ recall5=✓ rank=1
ranking-004  score=2/2 top1=✓ recall5=✓ rank=1
ranking-005  score=2/2 top1=✓ recall5=✓ rank=1
ranking-006  score=1/2 top1=✗ recall5=✓ rank=2
ranking-007  score=1/2 top1=✗ recall5=✓ rank=2
ranking-008  score=1/2 top1=✗ recall5=✓ rank=2
ranking-009  score=1/2 top1=✗ recall5=✓ rank=2
ranking-010  score=1/2 top1=✗ recall5=✓ rank=2
ranking-011  score=1/2 top1=✗ recall5=✓ rank=5
ranking-012  score=1/2 top1=✗ recall5=✓ rank=3
ranking-013  score=2/2 top1=✓ recall5=✓ rank=1
ranking-014  score=2/2 top1=✓ recall5=✓ rank=1
ranking-015  score=2/2 top1=✓ recall5=✓ rank=1

Final score: 22/30
Total runtime: 213ms

--- Sub-2/2 fixtures (8) ---

ranking-002: Is semantic search a Pro feature?
  score=1/2 top1=✗ recall5=✓
  rank-of-first-expected: 2
  top-5 returned: [{"session_id":"t2sess001","turn_index":0},{"session_id":"t2sess002","turn_index":0},{"session_id":"t2sess002","turn_index":1},{"session_id":"t2sess001","turn_index":1}]

ranking-006: What base image are we using for the strata-mcp Docker image now?
  score=1/2 top1=✗ recall5=✓
  rank-of-first-expected: 2
  top-5 returned: [{"session_id":"r6sess001","turn_index":0},{"session_id":"r6sess001","turn_index":2},{"session_id":"r6sess001","turn_index":1}]

ranking-007: What Postgres version are we on right now?
  score=1/2 top1=✗ recall5=✓
  rank-of-first-expected: 2
  top-5 returned: [{"session_id":"r7sess003","turn_index":1},{"session_id":"r7sess003","turn_index":0},{"session_id":"r7sess002","turn_index":0},{"session_id":"r7sess001","turn_index":0},{"session_id":"r7sess001","turn_index":1}]

ranking-008: What runner image is strata-pro CI currently using?
  score=1/2 top1=✗ recall5=✓
  rank-of-first-expected: 2
  top-5 returned: [{"session_id":"r8sess003","turn_index":1},{"session_id":"r8sess003","turn_index":0},{"session_id":"r8sess002","turn_index":0},{"session_id":"r8sess002","turn_index":1},{"session_id":"r8sess001","turn_index":0}]

ranking-009: What Node version were we previously running before the bump?
  score=1/2 top1=✗ recall5=✓
  rank-of-first-expected: 2
  top-5 returned: [{"session_id":"r9sess001","turn_index":1},{"session_id":"r9sess001","turn_index":0},{"session_id":"r9sess002","turn_index":0},{"session_id":"r9sess002","turn_index":1}]

ranking-010: What's the storage layer for the per-tenant rate limit token bucket?
  score=1/2 top1=✗ recall5=✓
  rank-of-first-expected: 2
  top-5 returned: [{"session_id":"r10sess001","turn_index":0},{"session_id":"r10sess001","turn_index":2},{"session_id":"r10sess001","turn_index":3},{"session_id":"r10sess001","turn_index":4}]

ranking-011: What answer model does the harness use currently?
  score=1/2 top1=✗ recall5=✓
  rank-of-first-expected: 5
  top-5 returned: [{"session_id":"r11sess003","turn_index":0},{"session_id":"r11sess003","turn_index":1},{"session_id":"r11sess002","turn_index":0},{"session_id":"r11sess002","turn_index":1},{"session_id":"r11sess001","turn_index":0}]

ranking-012: What IaC tool are we using now?
  score=1/2 top1=✗ recall5=✓
  rank-of-first-expected: 3
  top-5 returned: [{"session_id":"r12sess002","turn_index":0},{"session_id":"r12sess002","turn_index":1},{"session_id":"r12sess001","turn_index":0}]
```

## Analysis

**ranking-002:** `isTemporalCurrentStateQuestion("Is semantic search a Pro feature?")` returns false — the query lacks explicit temporal markers. Without recency boost, BM25 favors the older session's turn ("Semantic search is a Pro feature") for keyword overlap. Improvement: expand the temporal classifier to cover present-tense state queries, or add a user-role preference in within-session ordering.

**ranking-006:** Single-session fixture. `applyTurnRecencyBoost` no-ops (all hits share the same `createdAt` session bucket, or only one session). BM25 ranks the first turn (alpine mention) over the third turn (debian-slim correction). Improvement: within-session later turns should rank higher for current-state queries when a correction pattern is detected.

**ranking-007/008:** Recency boost correctly surfaces newest session. But within that session, the assistant confirmation turn (turn_index=1) gets a slightly higher BM25 rank than the user decision turn (turn_index=0) due to content overlap. Improvement: prefer user-role turns over assistant turns for information retrieval, or use turn_index as a tiebreaker within a session.

**ranking-009:** Historical marker veto worked correctly — no recency boost applied. Within the older session (r9sess001), the assistant reply (turn_index=1: "Node 20 is LTS...") outranks the user statement (turn_index=0: "I'm on Node 20...") on BM25. Expected evidence is the user statement. Improvement: prefer user turns for factual assertions.

**ranking-010:** Single-session correction. Initial Redis mention (turn_index=0) has stronger BM25 than the SQLite correction (turn_index=2). BM25 cannot model "later turns override earlier turns." Improvement: within-session recency ordering for single-session fixtures.

**ranking-011:** `currently` keyword triggered recency dominance. Newest session (toolkit admin nav) is unrelated but ranks top-4. Relevant older session barely makes top-5 (rank=5). Anomaly: confirms that "current state" queries fire even when newest sessions have zero relevance to the query topic. Documents that the recency boost doesn't consider per-turn topic relevance before boosting.

**ranking-012 (designed failure):** Confirmed — recency boost fires on "now" in "What IaC tool are we using now?", surfaces newer session (Terraform mentions) before older session (Pulumi decision). Evidence at rank 3 as predicted. Improvement direction: per-turn relevance threshold before applying session dominance.

## Next experiments to consider

- Per-turn relevance threshold before applying session dominance (target ranking-012, ranking-011)
- Within-session ordering: prefer user turns over assistant turns (target ranking-007, 008, 009)
- Expand `isTemporalCurrentStateQuestion` to cover more present-tense query patterns (target ranking-002)
- Within-session recency ordering for single-session current-state fixtures (target ranking-006, 010)
- Re-run after any change to query-classifier markers
- Re-run after any change to applyTurnRecencyBoost
