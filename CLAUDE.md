# Strata (Community Edition)

This is the core memory engine for AI coding assistants. It indexes conversation history from Claude Code, Codex CLI, Aider, Cline, and Gemini CLI into a local SQLite/FTS5 database and exposes MCP tools for search and recall.

## Strata Family — Mono Repo Relationship

All Strata repos live side-by-side under a shared parent directory and form a layered product:

```
strata/          ← THIS REPO — Community edition, core engine (free, 8 MCP tools)
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
The Semgrep rules are shared across all Strata repos. When updating rules, propagate changes to strata-pro/, strata-team/, and strata-web/.

## Strata Memory

This project uses Strata MCP tools for persistent memory across sessions. When available:
- Search for prior solutions before debugging: `find_solutions`
- Store important decisions and fixes: `store_memory`
- Check project context at session start: `get_project_context`
- Use `/recall`, `/remember`, `/gaps`, `/strata-status` slash commands for quick access
