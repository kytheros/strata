# Changelog

All notable changes to the Strata Community Edition will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-04-01

### Added

- **Community LLM extraction** — Gemini-powered knowledge extraction and session summarization, activated when `GEMINI_API_KEY` is set. Replaces the previous heuristic-only pipeline with structured LLM analysis.
- **Training data capture pipeline** — Passively accumulates (input, output) pairs from every LLM extraction and summarization into a `training_data` table. No user action required; pairs build up as you use Strata normally.
- **Hybrid provider** — Local-first inference with frontier fallback. Once a distilled model is activated, extraction routes to the local model first and falls back to Gemini only when confidence is low.
- **`strata distill` CLI commands** — `status` (training data counts and readiness), `export-data` (JSONL export), `activate` (enable hybrid provider), `deactivate` (revert to frontier-only).
- **Python SDK training pipeline** — `strata-py` package with QLoRA fine-tuning, eval scoring, and GGUF export to Ollama. Install via `pip install strata-memory[distill]`.
- **Security hardening for extraction pipeline** — Sanitizer wired into all LLM calls and training data capture (redacts secrets before they reach the model). Localhost-only Ollama endpoint validation. Base model allowlist prevents loading arbitrary model files.

### Changed

- **Search retrieval quality (30/30)** — AutoResearch-optimized keyword search ranking parameters. `rrfK` tuned to 40, `rrfDualListBonus` to 0.3, `vectorSimBonus` to 0.005. Recency boosts, project match boost, and memory decay penalties empirically validated.
- **Chunking strategy (25/25)** — Increased `chunkSize` from 500 to 1600 tokens. Larger chunks preserve more conversational context, improving recall accuracy without sacrificing precision.
- **RRF fusion weights (58/58)** — Optimized Reciprocal Rank Fusion parameters that combine FTS5 BM25 keyword results with vector cosine similarity. BM25 `k1=1.2`, `b=0.75`. Importance signal weights balanced across type (0.35), frequency (0.35), language (0.20), and explicit (0.10).
- **MCP tool descriptions (25/25)** — AutoResearch-optimized all 15 MCP tool descriptions for clarity and discoverability by AI coding assistants.

### Fixed

- Semgrep SAST rule propagation across all repo copies.

## [1.2.1] - 2026-03-08

### Fixed

- Exclude `init-gemini.ts` from Semgrep child-process rule (false positive).

## [1.2.0] - 2026-03-08

### Added

- Gemini CLI integration — init command, hooks, skills, file watcher.

## [1.1.0] - 2026-03-07

### Added

- Semantic search with Gemini embeddings in community edition.
- Dashboard query methods to community stores.
- Polar license key activation and download CLI commands.

## [1.0.0] - 2026-03-06

### Added

- Initial release — SQLite/FTS5 memory engine with MCP tools.
- stdio and HTTP transport modes (single-tenant and multi-tenant).
- Conversation indexing for Claude Code, Codex CLI, Aider, Cline, Gemini CLI.
- Security scanning pipeline (Semgrep, Gitleaks, npm audit).
