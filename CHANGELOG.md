# Changelog

All notable changes to the Strata Community Edition will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.0] - 2026-05-11

### Added

- **Provenance handles on all search tool responses** (`search_history`, `find_solutions`). Each result header now includes a `[mem:<short> sess:<short> t:<date>]` bracket-citation so calling agents can cite their sources without follow-up lookups. Citations appear only for knowledge-store results (memories written via `store_memory`); raw FTS5 conversation chunks remain unchanged.
- **`Sources:` block on `get_project_context` narrative output.** When knowledge entries exist for the project, a trailing `Sources: [mem:…] [mem:…]` line is appended listing all referenced memory bracket-handles.
- **`getEditCount(id): Promise<number>`** on `SqliteKnowledgeStore`. Returns the count of explicit `update` events in `knowledge_history` for an entry (0 for a freshly-added entry, increments on each `updateEntry()` call).
- **`ProvenanceHandle` interface** exported from `strata-mcp` (`src/types/provenance.ts`). Encodes `id`, `sessionId`, `createdAt`, `updatedAt`, and `editCount` for a single memory row.
- **`formatProvenanceHandle(p: ProvenanceHandle): string`** utility (`src/utils/format-provenance.ts`). Renders a 6-char short-id bracket citation: `[mem:k_8a3fb4 sess:s_7d21e9 t:2024-05-08]`.
- **`provenance?: ProvenanceHandle`** field added to `SearchResult` (additive, optional per D3). Populated by `knowledgeEntryToSearchResult` for all knowledge-store paths.
- **`buildProvenanceSources(entries: KnowledgeEntry[]): string`** exported from `get-project-context.ts`. Builds a deduplicated `Sources:` line from a list of knowledge entries.
- **Cross-transport provenance test** (`tests/transports/provenance-transport.test.ts`). Verifies the bracket-handle survives MCP JSON-RPC serialization through the HTTP transport.

## [2.1.3] - 2026-05-03

### Removed

- **Cloudflare D1 deploy template no longer scaffolds an unreleased tier.** The Team-tier worker entry point (`templates/cloudflare-d1/src/index.team.ts`) and the corresponding `tier === "team"` branch in `strata deploy cloudflare` were premature — the upstream Team package isn't published yet, so a user with `tier: "team"` in `~/.strata/config.json` would have produced a worker scaffold whose `npm install` failed. Removed both. Pro and community paths are unchanged. The branch will return when Team launches.

### Documentation

- `downloadAndInstall` JSDoc no longer lists `team` as a valid `tier` value.

## [2.1.2] - 2026-05-03

### Documentation

- Code-review follow-ups from 2.1.1: comment on `runSearch` explains why the knowledge-store query receives the raw `query` while the FTS5 engine receives `searchQuery` (the engine understands `tool:X` inline filters; the knowledge store does plain-text search and would match `"tool:X"` literally). JSDoc on `knowledgeEntryToSearchResult` notes that `confidence` is currently redundant with `score / 10` and explains why the field is kept (forward-compat for future bonus terms).

## [2.1.1] - 2026-05-03

### Fixed

- **`strata search` (CLI) now surfaces explicit memories.** Memories written via `strata store-memory` were invisible to the CLI's `search` command — `runSearch` only queried the FTS5 document index and never consulted the `knowledge` table. The MCP-tool path (`search_history`) was unaffected. Fix routes the CLI through the same knowledge-store query the MCP tool uses, with a new shared `knowledgeEntryToSearchResult` util in `src/search/` so both paths share one mapping. Document and knowledge results are merged, sorted by score descending, and `--limit` is applied to the merged list.

## [2.1.0] - 2026-05-03

### Added

- **TIR+QDP early access.** New turn-level retrieval lane plus query-driven pruning, opt-in via `search.useTirQdp` (default `false`). Adds the `knowledge_turns` table (FTS5 + porter tokenizer on SQLite, tsvector + GIN on Postgres, mirrored on D1) alongside the existing chunk lane. New `KnowledgeTurnStore` (SQLite + Postgres adapters), `fuseCommunityLanes` RRF wrapper byte-identical to the NPC fusion math, `recallQdpCommunity` pruner mirroring NPC QDP rules. `IncrementalIndexer` writes both lanes per ingest when a `KnowledgeTurnStore` is wired.
- **`strata index --rebuild-turns` CLI.** Backfills the `knowledge_turns` table from existing session files. Idempotent (delete-then-reinsert per session). `--project` and `--dry-run` flags supported. Run this before flipping `search.useTirQdp = true`.
- **Frozen Community retrieval eval.** New 10-scenario eval at `evals/community-recall-tir-qdp/` covering buried-fact recall, distractor saturation, near-duplicate redundancy, cross-project / cross-user isolation, solution bias, recency-on-conflict, multi-session merge, query-coverage floor, and seed-only baseline. Initial score: 10/10. NPC frozen eval regression check: 16/16.
- **Upgrade guide.** New `docs/upgrade-guide.md` covers the two-step opt-in (`strata index --rebuild-turns`, then `strata config set search.useTirQdp true`) and the rollback path. Web docs site mirrors the same.
- **`parseTurns()` on the parser interface.** All five conversation parsers (Claude Code, Codex, Aider, Cline, Gemini) now expose `parseTurns()` for the turn-write path.

### Changed

- **`IKnowledgeTurnStore` is async.** All store methods return `Promise<T>`. Lets the SQLite and Postgres adapters share one interface contract; runtime behavior on SQLite is unchanged (the wrapped sync calls resolve immediately).

### Notes

- All Phase 1 changes are **invisible to MCP callers** until the flag is flipped. `search_history`, `find_solutions`, and `semantic_search` continue to operate against the existing chunk lane only. Phase 2 will wire the turn lane behind the flag.
- LongMemEval validation of the recall improvement is deferred to [#5](https://github.com/kytheros/strata/issues/5) (TIRQDP-2.3 follow-up).
- Two follow-up tickets were filed during the release pass: [#6](https://github.com/kytheros/strata/issues/6) (`CommunityChunkResult.createdAt` plumbing — must be fixed before `search_history` integration) and [#7](https://github.com/kytheros/strata/issues/7) (eval scenario 01 assertion documentation).

## [2.0.2] - 2026-05-01

### Changed

- **PDF embedding hybrid path.** PDFs with ≤6 pages continue to use
  Gemini's multimodal PDF embedding (text + figures + layout). PDFs with
  more than 6 pages now embed via per-page text extraction (no multimodal
  signal on the long tail). New `STRATA_PDF_MAX_PAGES` env var (default
  `100`) caps the text-only path. Image-only scanned PDFs >6 pages are
  not searchable on this release; track [kytheros/strata#4](https://github.com/kytheros/strata/issues/4)
  for the image-rendering follow-up.
- Existing PDF documents in user databases are not auto-reindexed.
  Users with visual-heavy long PDFs may delete and re-store via
  `delete_memory` + `store_document` if they want the new embedding shape.

### Removed

- `pdf-lib` runtime dependency. Clears the Socket.dev "obfuscated code"
  alert on the public package page.

## [2.0.1] - 2026-04-30

### Added

- **`strata backup push/pull/status`** — BYO-bucket backup commands for multi-device continuity and disaster recovery. Upload `~/.strata/strata.db` to any S3-compatible provider (AWS S3, Cloudflare R2, Backblaze B2, MinIO) with `strata backup push s3://bucket/key`. Restore with `strata backup pull`. Check local vs. remote state with `strata backup status`. Credentials read from standard AWS env vars (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`); set `AWS_ENDPOINT_URL` for non-AWS providers. Push is atomic (temp-key + rename) and writes a SHA-256 sidecar; pull verifies the sidecar before committing. Store a default URI in `~/.strata/backup.json` to omit the argument. Uses `better-sqlite3`'s online backup API so a running server is never snapshotted mid-write. Use `--force` to skip the newer-local-DB confirmation prompt.

### Security

- **Patched esbuild dev-server CSRF advisory** — `esbuild` is forced to `^0.25.0` via npm `overrides` (was 0.21.5 transitively via vitest's vite). End users installing `strata-mcp@2.0.1` now get the patched esbuild in their dependency tree.
- Pinned `vite` floor to `^5.4.20` (transitive via vitest) — the path-traversal CVE in vite remains in the vite 5.x line and is fixed only in 6.4.2+, but is dev-only and not exploitable in our deployment topology (we don't expose a vite dev server). Documented in `socket.yml`.

### Documentation

- **Network access disclosure in README** — explicit list of opt-in integrations (Gemini, OpenAI, Anthropic, Cohere, S3 backup) with endpoints and trigger conditions, plus a statement that Strata makes zero outbound calls when no API keys are set.
- **Added `socket.yml`** — Socket Security configuration acknowledging the intentional `hasNetwork` alert and documenting accepted false positives (`pdf-lib` minification heuristic, deprecated transitive `boolean` and `prebuild-install`).

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
