# Baseline — Dense Turn-Lane (single-session-assistant)

**Frozen baseline:** dense turn-lane OFF (`STRATA_DENSE_TURN_LANE` unset → `CONFIG.search.denseTurnLane.enabled=false`, `CONFIG.benchmark.denseTurnLane.mode="off"`).

**Config:** full LongMemEval-S (500Q), `vertex:gemini-2.5-flash` answer (temp-0, deterministic), `gpt-4o-2024-08-06` judge, `--judge-votes=3`, `--top-k=20 --prompt=category --session-scoring --reranker=onnx --events`, warm embedding cache.

**Run:** `2026-06-03`, run-id `vtx-off`, `data/results-full-topk20-session-rerank-onnx-events-top10-2026-06-03T11-29-08-386Z.json`.

| Metric | Value |
|---|---|
| Task-averaged | **80.81%** |
| Raw | 80.60% |
| information_extraction | 85.3% |
| └ single-session-assistant (slice) | 76.8% (43/56) |
| multi_session_reasoning | 75.2% |
| temporal_reasoning | 78.2% |
| knowledge_update | 84.6% |

This reproduces the historical Vertex baseline (~80.6%), confirming the harness is trustworthy. The single-session-assistant slice (76.8%, 43/56) is the gap the dense turn-lane targets.

**Note:** an earlier OFF baseline was also measured on the Gemini-API answer model (`gemini-2.5-flash`, temp 1.0): task-avg 79.32%/79.83% (N=2). Vertex temp-0 is the canonical baseline (deterministic, reproduces history); the Gemini-API runs were superseded after a quota wall.
