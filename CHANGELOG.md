# Changelog

All notable changes to the Strata Community Edition will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-04-27

### ⚠️ Breaking changes

- **REST transport now requires a configured signing secret.** `strata serve --rest` refuses to start without `STRATA_TOKEN_SECRET` set or `STRATA_ALLOW_INSECURE_DEV_SECRET=1` opt-in. Previously a publicly-known development fallback was silently used. Generate a secret with `openssl rand -hex 32`. See the [REST transport docs](https://strata.kytheros.dev/docs/game-engine-api).
- **Multi-tenant HTTP transport requires a verified auth proxy in production.** Setting `STRATA_REQUIRE_AUTH_PROXY=1` is now required for any deployment where untrusted clients can reach the port. The proxy must send `X-Strata-Verified: <token>` matching `STRATA_AUTH_PROXY_TOKEN`. Previously the `X-Strata-User` header alone was trusted. Local-dev and single-user self-hosted deployments behind a private network boundary remain unchanged.
- **REST transport requires the world-scoped layout.** Existing installations must run `strata world-migrate` and `strata rest-migrate` before starting `strata serve --rest`. The MCP transports (stdio and `strata serve` without `--rest`) are unaffected and still work on legacy layouts.
- **Request bodies capped at 1 MB.** REST and single-tenant HTTP transports return HTTP 413 for bodies above the limit. Previously unbounded.

### Added

- **REST transport for game engines (stable)** — bearer-auth REST API for Unity, Godot, Unreal, and other non-MCP clients. Two-tier auth (admin tokens issue player tokens), per-NPC memory routes, dialogue-shaped `/recall` endpoint that returns ready-to-prompt context. 22 routes covering worlds, players, agents, profiles, relationships, and cross-NPC gossip. Full reference at [Game Engine REST API](https://strata.kytheros.dev/docs/game-engine-api).
- **NPC recall — TIR + RRF fusion + rules-only QDP.** Turn-indexed retrieval with rank fusion across turn and fact retrieval lanes; dedupe + filler-filter + coverage-floor query-document processing; hedge filter for hearsay tagging; self-utterance provenance scoring. Frozen eval at 10/10 across the full stress battery.
- **`npc_turns` store with FTS5.** Separate raw-turn table mirrored into FTS5 with sync triggers. `NpcTurnStore` provides add/search/count over the lane.
- **Async extraction worker.** REST writes enqueue extraction jobs to a SQLite-backed queue and return immediately. Worker processes with retry backoff and per-tenant isolation. Replaces synchronous LLM blocking on the `/store` path.
- **Bulk delete endpoint** — `DELETE /api/agents/:agentId/memories` resets all memories for an agent (world-scoped in v2 layout, per-player in legacy).
- **D1 knowledge FTS** — `knowledge_fts` virtual table with BM25 and AND→OR fallback, parity with the SQLite knowledge store.
- **Postgres storage adapter routing** — `STRATA_STORAGE=pg` loads `createPgStorage`, enabling Postgres-backed deployments alongside SQLite and D1.
- **Hedge filter + hearsay extraction.** Extraction prompts emit `hedge` and `hearsay` fields; downstream filtering reduces hallucination from speculative content.
- **MCP tool annotations.** All 15 community tools carry `readOnlyHint` / `destructiveHint` metadata for clients that surface tool intent.
- **Migration commands** — `strata world-migrate` upgrades pre-v2 installations to the world-scoped REST layout; `strata rest-migrate` performs REST-specific migration.
- **`/recall` response shape** — includes `createdAt` and `speaker` per result.

### Changed

- **Aider and Gemini CLI parsers are now Community.** Previously gated to Pro, the auto-indexing parsers for Aider and Gemini CLI ship in the free tier. All five coding-agent parsers (Claude Code, Codex, Cline, Gemini CLI, Aider) are now baseline Community capability.
- **Aider parser recursion.** Discovers history files up to 3 directory levels deep (was top-level only).
- **Gemini parser** — populates `cwd` from project directory; supports v2 conversation format.
- **Watcher** — corrects `projectDir` resolution for non-claude-code parsers.
- **Distillation setup** — pulls `gemma3:1b` and `gemma3:4b` alongside Gemma 4; probes `OLLAMA_NUM_PARALLEL` for parallelism guidance; clarifies cross-platform setup.
- **Distill CLI install messaging** — clarifies that `strata-memory[distill]` is in alpha and not yet on PyPI; tracks publish at https://github.com/kytheros/strata-py/issues/1.

### Fixed

- Multi-tenant admin auth tests properly exercise auth paths (was bypassing).
- HTTP transport tests repaired via `serverFactory` pattern.
- Extraction prompt passes `jsonMode: true` to provider for stricter output shape; logs LLM failure before heuristic fallback.
- Gemini provider sources API key from `~/.strata/config.json`; warns when worker is disabled.
- NPC profile decay persists `decayProfileExplicit` sentinel so `"normal"` round-trips correctly.
- `localTimeoutMs` override behavior locked in by regression tests.
- Removed dead `handleProfile` REST handler that was never wired.

### Security

- REST transport refuses insecure defaults (see Breaking Changes).
- Multi-tenant transport enforces verified auth proxy in production (see Breaking Changes).
- Request body cap (1 MB) protects against memory-exhaustion attacks on REST and single-tenant HTTP transports.
- Hedge filter reduces hallucination surface from speculative LLM extraction content.

### Migration guide

For existing installations upgrading from 1.x:

1. **Stop your Strata server(s).**
2. **Back up your data directory** (default `~/.strata/`).
3. **Update the package**: `npm install -g strata-mcp@2.0.0`.
4. **If you use the REST transport**:
   - Run `strata world-migrate` to upgrade to the world-scoped layout.
   - Run `strata rest-migrate` to perform REST-specific migration.
   - Generate a token secret: `openssl rand -hex 32`.
   - Set `STRATA_TOKEN_SECRET=<secret>` in your environment.
5. **If you run multi-tenant HTTP behind untrusted clients**:
   - Set `STRATA_REQUIRE_AUTH_PROXY=1`.
   - Set `STRATA_AUTH_PROXY_TOKEN=<random ≥32 chars>`.
   - Configure your upstream proxy to send `X-Strata-Verified: <token>` after authenticating each request.
6. **Restart your server.**

The MCP stdio and single-tenant HTTP transports do not require any migration step. If you only use those transports, simply update the package.

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
