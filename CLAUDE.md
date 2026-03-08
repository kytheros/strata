## Security Scanning

This project uses a shared security scanning pipeline across the Strata family:
- **strata/** (this repo) — Community edition, core memory engine
- **strata-pro/** — Enterprise features (extends strata)
- **strata-team/** — Team edition (extends strata + strata-pro)
- **strata-web/** — Marketing/auth frontend (React + Supabase)

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
