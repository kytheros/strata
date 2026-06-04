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

User scope comes from the `X-Strata-User` HTTP header (must be UUID format). Routes: `POST/GET/DELETE /mcp`, `GET /health` (liveness only — pool stats moved to `/admin/pool` behind `STRATA_ADMIN_TOKEN`), `GET /admin/pool` (pool stats + per-user details, requires `Authorization: Bearer <STRATA_ADMIN_TOKEN>`).

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
- `src/transports/multi-tenant-http-transport.ts` — multi-tenant HTTP transport (owns the inline LRU user pool)

`createServer()` in `src/server.ts` accepts an optional `{ dataDir }` parameter to override the database location. In multi-tenant mode, each user gets their own `createServer()` instance with isolated caches, IndexManager, and database. Watchers (RealtimeWatcher, IncrementalIndexer) are not started in multi-tenant mode.

### Dense turn-lane in multi-tenant mode

When `GEMINI_API_KEY` is present, Strata automatically activates the dense turn-lane (per-turn vector embeddings) for every tenant. This improves recall on within-session questions but has cost implications in multi-tenant deployments because **all tenants share the same API key**:

- **Default ON** when a provider is present. Kill-switch: set `STRATA_DENSE_TURN_LANE=off` to disable for all tenants.
- **Concurrency cap**: a process-global semaphore limits concurrent `embedBatch` calls to `STRATA_DENSE_TURN_MAX_CONCURRENCY` (default 5). This prevents one large tenant's initial index build from exhausting quota and degrading all others to FTS5-only search. Raise the cap on a dedicated host with higher quota; lower it if you see 429 errors from the embedding API.

| Env Var | Default | Purpose |
|---------|---------|---------|
| `STRATA_DENSE_TURN_LANE` | on | Set to `off` to disable dense turn-lane for all tenants. |
| `STRATA_DENSE_TURN_MAX_CONCURRENCY` | 5 | Max concurrent embedding batch calls across all tenants. |

### REST transport token secret

The REST transport (`strata serve --rest`) signs player bearer tokens with
HMAC. It refuses to start unless one of the following is set:

| Env Var | Purpose |
|---------|---------|
| `STRATA_TOKEN_SECRET=<random>` | The signing key. Use `openssl rand -hex 32`. Required for any production deployment. |
| `STRATA_ALLOW_INSECURE_DEV_SECRET=1` | Opt into a publicly-known dev fallback secret. Warns loudly. Local dev only. |

Setting neither aborts startup with a diagnostic pointing at both paths.

### Token rotation

Rotating `STRATA_TOKEN_SECRET` normally invalidates every player token immediately. To avoid mid-session disruption, use a grace-window rotation:

| Env Var | Purpose |
|---------|---------|
| `STRATA_TOKEN_SECRET=<new>` | Current signing key. All new tokens are signed with this. |
| `STRATA_TOKEN_SECRET_PREVIOUS=<old>` | Accept-only. Tokens signed with the old key still verify during the grace window. |

**Rotation procedure:**

1. Set `STRATA_TOKEN_SECRET_PREVIOUS` to the current value of `STRATA_TOKEN_SECRET`.
2. Update `STRATA_TOKEN_SECRET` to the new secret (`openssl rand -hex 32`).
3. Restart the REST transport. New tokens are signed with the new secret; existing tokens signed with the old secret continue to verify.
4. After a suitable grace window (e.g., one session length — however long players stay logged in), unset `STRATA_TOKEN_SECRET_PREVIOUS` and restart.

Note: `STRATA_TOKEN_SECRET_PREVIOUS` is never used for signing — only for verification. Tokens signed with the old key remain valid only while the previous secret env var is set.

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

## Benchmark Methodology

LongMemEval-S benchmark runs from `benchmarks/longmemeval/` follow
**N>=3 canary discipline** for any result that will ship externally:

1. Use `--judge-votes=3` to collapse GPT-4o judge variance per question
2. Use `npx tsx benchmarks/longmemeval/run-canary.ts --runs=3` for shipped scores
3. Single-run verdict deltas in the ~0.5-1pp range are NOT trustworthy

See `benchmarks/longmemeval/README.md` for the flag reference and
`specs/2026-05-29-eval-methodology-judge-noise-design.md` for the
empirical basis. The judge-noise finding is also persisted in Strata memory.

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

## Codebase Knowledge Graph

A pre-computed structural + semantic knowledge graph lives at
`.understand-anything/knowledge-graph.json`, generated by the
[Understand-Anything](https://github.com/Lum1104/Understand-Anything)
plugin. It contains:

- **1,282 nodes** (630 files + function/class/config breakdown) across
  **10 named layers** (Core Memory Engine, Storage & Schema,
  Transport & MCP Tools, Test Suite, Evaluation & AutoResearch,
  Entry & CLI, Documentation & Skills, Infrastructure & Project Config,
  CI/CD Pipelines, Shared Utilities & Types)
- **1,352 edges** with types `contains`, `exports`, `calls`,
  `tested_by`, `imports`, `depends_on`, `migrates`, `related`,
  `triggers`, `documents`, `configures`, `deploys`, `implements`
- LLM-generated plain-English summary + tags + complexity rating per node

**Consult the graph before reading widely.** For any task that touches
multiple files (cross-cutting refactor, multi-file feature, orientation
to an unfamiliar area), the graph is faster and cheaper than Read/Grep
sweeps. For narrow edits (fix one function), Read source directly.

### Query commands

Use `npm run graph:query <command>` (or `node scripts/query-graph.mjs`
directly). All four commands accept a file path and use case-insensitive
substring matching when an exact path doesn't match.

| Command | Returns |
|---|---|
| `npm run graph:query summarize <filePath>` | LLM summary + layer + tags + language notes for one file |
| `npm run graph:query layer [name]` | Nodes in a layer (or list all layers if no name given) |
| `npm run graph:query tests-for <filePath>` | Tests linked to this file via `tested_by` edges |
| `npm run graph:query dependents <filePath>` | Files that depend on this file (reverse `calls`/`imports`/`depends_on`) |

**Example workflow:** Asked to "add a new MCP tool for X" → run
`npm run graph:query layer "Transport & MCP Tools"` → get the existing
tool list with summaries → read one or two for pattern → write the new
tool. Skips reading 30+ unrelated files.

### Staleness

- The graph is captured at a specific commit (see `.understand-anything/meta.json`
  for `gitCommitHash`). It's stale the moment any code changes.
- Pre-push hook surfaces a tiered nudge: silent (0 changed files), one-line
  (1-20 changed), strong banner (>20 changed or ≥10 commits behind).
- Refresh manually with `/understand` (in Claude Code, or via the
  Understand-Anything plugin in any compatible runtime) when convenient
  — typically after merging a feature, before a code review, or when
  the strong banner fires. Incremental updates are cheap (~6-10 LLM calls
  for a small change, ~15-25 for a large change).
- Run `npm run graph:status` any time to check current staleness.
- For agents: **if your task touches files modified since the graph commit,
  fall back to Read/Grep** — summaries for those files are out of date.
  Use `npm run graph:status` to see the changed-file list.

### Caveats for agents

- Summaries are LLM-generated and directionally correct but occasionally
  wrong on edge cases — treat as orientation, verify by reading source
  before any code change.
- Edge data is mostly accurate but not exhaustive; absence of a
  `tested_by` edge does NOT mean no test exists.
- The graph is a snapshot — implementation work still requires reading
  actual source code. The graph saves you from reading the *wrong* files,
  not from reading the right ones.

## Strata Memory

This project uses Strata MCP tools for persistent memory across sessions. When available:
- Search for prior solutions before debugging: `find_solutions`
- Store important decisions and fixes: `store_memory`
- Check project context at session start: `get_project_context`
- Use `/recall`, `/remember`, `/gaps`, `/strata-status` slash commands for quick access
