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

## Existing Security Posture

For context on the project's threat model and existing controls, see:

- `docs/security-roadmap.md` (if present) — long-term security posture
- `.semgrep/custom-rules.yml` — static analysis rules enforced in CI
- `.gitleaks.toml` — secret-scanning configuration
- `CLAUDE.md` — project-level security notes including the multi-tenant auth-proxy contract
