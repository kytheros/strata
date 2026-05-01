# Strata (Community Edition)

This is the core memory engine for AI coding assistants. It indexes conversation history from Claude Code, Codex CLI, Aider, Cline, and Gemini CLI into a local SQLite/FTS5 database and exposes MCP tools for search and recall.

## Strata Family

Strata ships as a layered product family (separate packages, not included in this repo):

```
strata/          ← THIS REPO — Community edition, core engine (free, 15 MCP tools, includes semantic search)
strata-pro       ← Enterprise features: procedures, entity graph, analytics, ingestion, LLM extraction (separate npm package)
strata-team      ← Team edition: shared knowledge, team sync, RBAC (separate npm package)
strata-web       ← Marketing/auth frontend (separate repo)
strata-worker    ← Cloudflare Worker: licensed release distribution (separate repo)
```

### Dependency Chain

```
strata (this repo, published as "strata-mcp" on npm)
  ↑ imported by strata-pro (via "strata-mcp" from npm)
      ↑ imported by strata-team (via "@kytheros/strata-pro" from npm)
```

- **strata-pro** wraps this repo's server and adds license-gated Pro tools (separate npm package)
- **strata-team** wraps strata-pro's server and adds team collaboration features (separate npm package)
- **strata-web** is independent (React SPA) — showcases and monetizes all tiers (separate repo)
- **strata-worker** is independent (Cloudflare Worker) — serves licensed release tarballs (separate repo)

### Key Exports Consumed by Downstream Packages

Other packages import from this package (`strata-mcp`). Changes to exported types, the MCP server factory (`src/server.ts`), or core stores (KnowledgeStore, SqliteEntityStore, IndexManager) can break strata-pro and strata-team. Test downstream after modifying exports.

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

**Multi-tenant deployments MUST run behind a verified auth proxy.**
`X-Strata-User` alone is a trust-the-header identifier — the backend has no
way to prove the caller owns the UUID they claim. For any deployment where
untrusted clients can reach the port, set:

| Env Var | Purpose |
|---------|---------|
| `STRATA_REQUIRE_AUTH_PROXY=1` | Require an `X-Strata-Verified` header on every `/mcp` request. |
| `STRATA_AUTH_PROXY_TOKEN=<random>` | Shared secret (≥32 chars). Set the upstream proxy to send this as `X-Strata-Verified` after it has verified the caller's identity and resolved their `X-Strata-User` UUID. |

The upstream proxy (Cloudflare Worker, Kong, Envoy, nginx+auth_request, etc.)
is responsible for: (1) authenticating the caller (JWT/session/mTLS/etc.),
(2) mapping them to a Strata user UUID, (3) setting `X-Strata-User` to that
UUID, and (4) setting `X-Strata-Verified: <token>`. Strata verifies the
sentinel in constant time and rejects any request missing or mismatching it.

For local dev and single-user self-hosted deployments, leave the flag unset;
the backend is then trusted to be behind a private network boundary.

Key files:
- `src/transports/http-transport.ts` — single-tenant HTTP transport
- `src/transports/multi-tenant-http-transport.ts` — multi-tenant HTTP transport
- `src/storage/database-pool.ts` — LRU database connection pool

`createServer()` in `src/server.ts` accepts an optional `{ dataDir }` parameter to override the database location. In multi-tenant mode, each user gets their own `createServer()` instance with isolated caches, IndexManager, and database. Watchers (RealtimeWatcher, IncrementalIndexer) are not started in multi-tenant mode.

### REST transport token secret

The REST transport (`strata serve --rest`) signs player bearer tokens with
HMAC. It refuses to start unless one of the following is set:

| Env Var | Purpose |
|---------|---------|
| `STRATA_TOKEN_SECRET=<random>` | The signing key. Use `openssl rand -hex 32`. Required for any production deployment. |
| `STRATA_ALLOW_INSECURE_DEV_SECRET=1` | Opt into a publicly-known dev fallback secret. Warns loudly. Local dev only. |

Setting neither aborts startup with a diagnostic pointing at both paths.

## Security Scanning

Shared security scanning pipeline across all Strata repos.

### Tools
- **Semgrep** — Custom SAST rules in `.semgrep/custom-rules.yml` (26 rules covering secrets, MCP security, injection, prototype pollution, Node.js security, supply chain)
- **Gitleaks** — Pre-commit hook prevents committing secrets. Config in `.gitleaks.toml`
- **npm audit** — Dependency vulnerability scanning in CI

### Local Commands
- `npm run security:scan` — Run Semgrep (requires Docker)
- `npm run security:secrets` — Run Gitleaks scan
- `npm run security:audit` — Run npm audit

### CI Pipeline
Security checks run automatically on PRs via `.github/workflows/ci.yml`. PRs are blocked if ERROR-severity findings are detected.

### Shared Rules
The Semgrep rules are shared across all Strata packages. When updating rules, propagate changes to strata-pro, strata-team, strata-web, and ai-readiness-toolkit.

## AutoResearch — Optimized Parameters

Search parameters in `src/config.ts` are empirically optimized via automated eval suites. Do not change them without re-running evals.

## Local Model Distillation

Users with `GEMINI_API_KEY` get LLM-powered extraction, conflict resolution,
and summarization via Gemini 2.5 Flash. With one command they can route the
entire pipeline through **Gemma 4** running locally via Ollama, with Gemini
remaining as a safety-net fallback.

### Quick start

```bash
strata distill setup   # Pulls gemma4:e4b + gemma4:e2b, writes config
strata distill test    # Verifies all three pipeline stages
```

See `docs/local-inference.md` for the full guide.

### Architecture
- `src/extensions/llm-extraction/llm-provider.ts` — `LlmProvider` interface + `OllamaProvider`
- `src/extensions/llm-extraction/gemini-provider.ts` — Gemini LLM provider
- `src/extensions/llm-extraction/hybrid-provider.ts` — Local-first with frontier fallback
- `src/extensions/llm-extraction/provider-factory.ts` — `getExtractionProvider()`, `getSummarizationProvider()`, `getConflictResolutionProvider()`. Auto-selects hybrid vs gemini based on `~/.strata/config.json`.
- `src/cli/distill.ts` — `status`, `export-data`, `activate`, `deactivate`, `setup`, `test`
- `src/sanitizer/sanitizer.ts` — Redacts secrets before LLM calls and training capture
- `evals/local-inference-quality/` — Frozen eval suite gating Gemma 4 ship

### CLI Commands
- `strata distill status` — Training data counts and readiness
- `strata distill export-data` — Export training pairs to JSONL
- `strata distill activate` — Enable hybrid provider (local-first)
- `strata distill deactivate` — Revert to frontier-only
- `strata distill setup` — One-step Gemma 4 local inference setup
- `strata distill test` — Verify all three pipeline stages

### Python SDK (strata-py)
The fine-tuning pipeline lives in `strata-py/strata/distill/`:
- `pip install strata-memory[distill]` — adds Unsloth/PyTorch
- `strata-distill start` — QLoRA fine-tuning (Gemma 4 is the recommended base)
- `strata-distill eval` — score against frozen eval
- `strata-distill export` — GGUF export + Ollama registration

## Strata Memory

This project uses Strata MCP tools for persistent memory across sessions. When available:
- Search for prior solutions before debugging: `find_solutions`
- Store important decisions and fixes: `store_memory`
- Check project context at session start: `get_project_context`
- Use `/recall`, `/remember`, `/gaps`, `/strata-status` slash commands for quick access
