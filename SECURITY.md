# Security Policy

Strata stores user conversation history, decisions, and extracted knowledge — sometimes including code snippets, API references, and operational details. We take security reports seriously and ask that you do too.

## Reporting a Vulnerability

**Please do not open a public GitHub issue, PR, or Discussion for security vulnerabilities.**

### Preferred: Private GitHub Security Advisory

Use the [Report a vulnerability](https://github.com/kytheros/strata/security/advisories/new) link in the Security tab of this repository. This creates a private advisory visible only to maintainers and provides a structured channel for triage and coordinated disclosure.

### Alternate: Email

Email **security@kytheros.dev** with:

- A description of the vulnerability and its impact
- Steps to reproduce (proof-of-concept code, request payloads, etc.)
- The affected version(s) of `strata-mcp`
- Whether you'd like credit in the advisory and how you'd like to be named

We will acknowledge receipt within **3 business days** and aim for an initial assessment within **7 business days**. Please give us a reasonable window to investigate and patch before public disclosure — typically 90 days, less for actively exploited issues.

## Scope

The following are considered in scope:

- The published `strata-mcp` npm package (any released version)
- The HTTP and multi-tenant transports (`strata serve`, `strata serve --multi-tenant`, `strata serve --rest`)
- Authentication, session, and token handling (REST player tokens, multi-tenant auth-proxy sentinel)
- Storage isolation across tenants and users (multi-tenant SQLite databases, D1 isolation, Postgres row-level scoping)
- Code injection paths (SQL, prompt injection that affects stored data, FTS5 query handling)
- Supply-chain integrity (package contents, dependency provenance)

The following are **out of scope**:

- Issues that require a malicious local user to already have read/write access to `~/.strata/strata.db` (the local database is trust-the-filesystem by design — protect it like any other config file)
- Issues in third-party MCP clients or AI providers (Claude, Gemini, etc.) — please report to those vendors directly
- Issues in dependencies that have already been published as advisories upstream — we track those via Dependabot and patch on the standard release cadence
- Theoretical attacks without a working proof-of-concept against a current release

## Supported Versions

We backport security fixes to the latest minor release. Older minor releases receive fixes only for critical issues (RCE, auth bypass, cross-tenant data leak) for the first 90 days after a new minor lands.

| Version | Supported |
|---------|-----------|
| 2.x.x   | ✓ Active  |
| < 2.0   | Critical fixes only, on request |

## Disclosure Practice

After a fix lands, we publish:

- A GitHub Security Advisory with severity, affected versions, and mitigation steps
- A note in `CHANGELOG.md` cross-referencing the advisory
- A new patch release on npm with the fix

If you reported the issue and asked for credit, we name you in the advisory. We do not currently run a paid bug-bounty program.

## Operator-PII Hygiene

This repository ships infrastructure templates that operators apply against their own AWS accounts. Operator-specific values — account IDs, personal emails, IAM usernames — must never land in committed code.

### Conventions

- **Operator-only files are gitignored.** Real values live in `templates/aws/.env`, `templates/aws/envs/dev/backend.dev.hcl`, and `templates/aws/envs/dev/terraform.tfvars`. Each has a committed `.example` seed showing the expected shape.
- **Placeholders in committed code:**
  - `<ACCOUNT_ID>` for 12-digit AWS account IDs
  - `<your-cli-user>` for IAM usernames
  - `you@example.com` for operator emails
- **Test fixtures use the AWS-recommended fake account ID `123456789012`.** This is allowlisted in Gitleaks; using any other 12-digit literal will trip the pre-commit gate.

### How the gate works

Three layers, all deterministic:

- **Pre-commit hook** (`.husky/pre-commit`) runs `gitleaks protect --staged`. Custom rules in `.gitleaks.toml` reject commits introducing AWS account IDs, the operator's personal/test emails, or hardcoded IAM usernames. Fast (<1s).
- **Pre-push hook — light gate** (`.husky/pre-push`) runs on every push: `npm test`, full-history Gitleaks, and `npm audit --audit-level=high`. ~75s on Windows.
- **Pre-push hook — heavy gate** (`scripts/preflight-docker.sh`) auto-runs when the push contains more than 5 commits. It executes the same Semgrep, TFLint, and Checkov scans CI runs, via pinned Docker images so workstation behavior matches CI exactly. ~100s with warm Docker caches. Bypass for one push: `git push --no-verify`.
- **CI** (`.github/workflows/security.yml` + `aws-template-ci.yml`) runs the same scans server-side. The local hooks exist to fail fast; CI is the source of truth.

The Gitleaks rules added for this purpose are: `aws-account-id-in-arn`, `aws-account-id-in-ecr-host`, `aws-account-id-in-cognito-host`, `aws-account-id-quoted`, `aws-account-id-state-bucket`, `operator-personal-email`, `operator-iam-username`. Each has an allowlist that exempts `123456789012` (the AWS-recommended fake) so test fixtures don't trip the gate.

The heavy gate's pinned Docker images are listed at the top of `scripts/preflight-docker.sh`. When CI bumps a version (`TFLINT_VERSION` / `CHECKOV_VERSION` in `.github/workflows/aws-template-ci.yml`, or the Semgrep base image), update the matching tag here so workstation parity with CI is preserved. Run `task ci:check` from `templates/aws/` to invoke the heavy gate on demand without pushing.

### Adding a new operator alias, account, or test email

Extend the relevant rule's `regex` field in `.gitleaks.toml`. Tighten allowlists rather than loosening rules — keeping the rule list specific is what keeps the false-positive rate near zero.

## Existing Security Posture

For context on the project's threat model and existing controls, see:

- `docs/security-roadmap.md` (if present) — long-term security posture
- `.semgrep/custom-rules.yml` — static analysis rules enforced in CI
- `.gitleaks.toml` — secret-scanning configuration
- `CLAUDE.md` — project-level security notes including the multi-tenant auth-proxy contract
