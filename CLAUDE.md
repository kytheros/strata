# Strata (Community Edition)

This is the core memory engine for AI coding assistants. It indexes conversation history from Claude Code, Codex CLI, Aider, Cline, and Gemini CLI into a local SQLite/FTS5 database and exposes MCP tools for search and recall.

## Strata Family — Mono Repo Relationship

All Strata repos live side-by-side under a shared parent directory and form a layered product:

```
strata/          ← THIS REPO — Community edition, core engine (free, 10 MCP tools)
strata-pro/      ← Enterprise features: semantic search, cloud sync, procedures, analytics
strata-team/     ← Team edition: shared knowledge, team sync, RBAC
strata-web/      ← Marketing/auth frontend (React + Supabase)
strata-worker/   ← Cloudflare Worker: licensed release distribution via R2/KV + Polar
```

### Dependency Chain

```
strata (this repo)
  ↑ imported by strata-pro (via "strata-mcp": "file:../strata")
      ↑ imported by strata-team (via "@kytheros/strata-pro": "file:../strata-pro")
```

- **strata-pro** wraps this repo's server and adds license-gated Pro tools
- **strata-team** wraps strata-pro's server and adds team collaboration features
- **strata-web** is independent (React SPA) — showcases and monetizes all tiers
- **strata-worker** is independent (Cloudflare Worker) — serves licensed release tarballs

### Key Exports Consumed by Downstream Repos

Other repos import from this package (`strata-mcp`). Changes to exported types, the MCP server factory (`src/server.ts`), or core stores (KnowledgeStore, SqliteEntityStore, IndexManager) can break strata-pro and strata-team. Test downstream after modifying exports.

## Transport Modes

Strata supports two transport modes for its MCP server:

### stdio (default)
```
strata                    # starts MCP server on stdio
```
Used by Claude Code, Gemini CLI, and other local MCP clients. Single user, single database at `$STRATA_DATA_DIR/strata.db` (default: `~/.strata/strata.db`).

### HTTP (single-tenant)
```
strata serve --port 3000
```
Streamable HTTP transport on `/mcp` with MCP session management. Single user, same database resolution as stdio. Routes: `POST/GET/DELETE /mcp`, `GET /health`.

### HTTP (multi-tenant)
```
strata serve --multi-tenant --data-dir /data/strata --port 3100 --max-dbs 200
```
Shared-process model for SaaS deployments. One Node.js process handles all users via an LRU database pool. Each user gets an isolated SQLite database at `{data-dir}/{userId}/strata.db`.

| Flag | Default | Purpose |
|------|---------|---------|
| `--multi-tenant` | off | Enable multi-tenant mode |
| `--data-dir <path>` | `$STRATA_DATA_DIR` or `~/.strata/` | Base directory for per-user databases |
| `--max-dbs <n>` | 200 | Max open databases in LRU pool |
| `--port <n>` | 3000 | HTTP listen port |

User scope comes from the `X-Strata-User` HTTP header (must be UUID format). Routes: `POST/GET/DELETE /mcp`, `GET /health` (pool stats), `GET /admin/pool` (per-user details).

Key files:
- `src/transports/http-transport.ts` — single-tenant HTTP transport
- `src/transports/multi-tenant-http-transport.ts` — multi-tenant HTTP transport
- `src/storage/database-pool.ts` — LRU database connection pool

`createServer()` in `src/server.ts` accepts an optional `{ dataDir }` parameter to override the database location. In multi-tenant mode, each user gets their own `createServer()` instance with isolated caches, IndexManager, and database. Watchers (RealtimeWatcher, IncrementalIndexer) are not started in multi-tenant mode.

## Security Scanning

Shared security scanning pipeline across all Strata repos.

### Tools
- **Semgrep** — Custom SAST rules in `.semgrep/custom-rules.yml` (16 rules covering secrets, MCP security, injection, prototype pollution, Node.js security)
- **Gitleaks** — Pre-commit hook prevents committing secrets. Config in `.gitleaks.toml`
- **npm audit** — Dependency vulnerability scanning in CI

### Local Commands
- `npm run security:scan` — Run Semgrep (requires Docker)
- `npm run security:secrets` — Run Gitleaks scan
- `npm run security:audit` — Run npm audit

### CI Pipeline
Security checks run automatically on PRs via `.github/workflows/ci.yml`. PRs are blocked if ERROR-severity findings are detected.

### Shared Rules
The Semgrep rules are shared across all Strata repos. When updating rules, propagate changes to strata-pro/, strata-team/, strata-web/, and ai-readiness-toolkit/.

## AutoResearch — Optimized Parameters

The core engine's search, indexing, and ranking parameters in `src/config.ts` were systematically optimized using Karpathy's AutoResearch pattern — an autonomous experiment loop that measures baseline, changes one variable, evaluates against a frozen test suite, and keeps or discards. All three optimization targets reached their scoring ceilings.

### Search Retrieval (30/30)
Optimized keyword search ranking. Key tuned values:
- `search.rrfK`: 40 (RRF fusion constant — lower = more weight to top ranks)
- `search.rrfDualListBonus`: 0.3 (bonus for docs appearing in both keyword + vector lists)
- `search.vectorSimBonus`: 0.005 (cosine similarity tiebreaker restoring magnitude info)
- `search.recencyBoost7d`: 1.1, `recencyBoost30d`: 1.05
- `search.projectMatchBoost`: 1.3
- `search.decayPenalty90d`: 0.85, `decayPenalty180d`: 0.7

### Chunking Strategy (25/25)
Optimized how conversation history is split into searchable chunks:
- `indexing.chunkSize`: 1600 tokens (up from 500 — larger chunks preserve more context)
- `indexing.chunkOverlap`: 50 tokens
- `indexing.maxChunksPerSession`: 500

### RRF Fusion Weights (58/58)
Optimized the Reciprocal Rank Fusion parameters that combine FTS5 BM25 keyword results with vector cosine similarity:
- `bm25.k1`: 1.2 (term frequency saturation)
- `bm25.b`: 0.75 (document length normalization)
- `learning.similarityThreshold`: 0.6 (Jaccard similarity for clustering)
- `importance.typeWeight`: 0.35, `languageWeight`: 0.20, `frequencyWeight`: 0.35, `explicitWeight`: 0.10

### Regression Checks
Scheduled tasks monitor for regressions:
- `autoresearch-search-retrieval` — Manual (at ceiling 30/30)
- `autoresearch-chunking-strategy` — Manual (at ceiling 25/25)
- `autoresearch-rrf-fusion` — Manual (at ceiling 58/58)

**Important:** These values were empirically validated. Do not change them without re-running the AutoResearch eval suites. The eval scripts are the source of truth — they are never modified during optimization.

## Local Model Distillation

Community users with `GEMINI_API_KEY` get LLM-powered extraction and summarization. Training pairs accumulate passively in the `training_data` table. When enough data is collected (~1,000 pairs), users can fine-tune a private local model via the Python SDK.

### Architecture
- `src/extensions/llm-extraction/gemini-provider.ts` — Gemini LLM provider (activated when API key set)
- `src/extensions/llm-extraction/enhanced-extractor.ts` — LLM extraction with training data capture
- `src/extensions/llm-extraction/smart-summarizer.ts` — LLM summarization with training data capture
- `src/extensions/llm-extraction/training-capture.ts` — Saves (input, output) pairs to `training_data` table
- `src/extensions/llm-extraction/hybrid-provider.ts` — Local-first with frontier fallback
- `src/extensions/llm-extraction/provider-factory.ts` — Auto-selects provider based on config
- `src/sanitizer/sanitizer.ts` — Redacts secrets before LLM calls and training capture

### CLI Commands
- `strata distill status` — Training data counts and readiness
- `strata distill export-data` — Export training pairs to JSONL
- `strata distill activate` — Enable hybrid provider (local-first)
- `strata distill deactivate` — Revert to frontier-only

### Python SDK (strata-py)
The fine-tuning pipeline lives in `strata-py/strata/distill/`:
- `pip install strata-memory[distill]` — adds Unsloth/PyTorch
- `strata-distill start` — QLoRA fine-tuning
- `strata-distill eval` — score against frozen eval
- `strata-distill export` — GGUF export + Ollama registration

## Strata Memory

This project uses Strata MCP tools for persistent memory across sessions. When available:
- Search for prior solutions before debugging: `find_solutions`
- Store important decisions and fixes: `store_memory`
- Check project context at session start: `get_project_context`
- Use `/recall`, `/remember`, `/gaps`, `/strata-status` slash commands for quick access
