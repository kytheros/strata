# Contributing to Strata

Thank you for your interest in contributing to Strata! This guide will help you get started.

## Development Setup

```bash
# Clone the repo
git clone https://github.com/kytheros/strata.git
cd strata

# Install dependencies
npm install

# Run tests
npm test

# Build
npm run build
```

### Prerequisites

- Node.js >= 18
- npm >= 9

No other system dependencies are required. SQLite is bundled via better-sqlite3.

## Running Tests

```bash
# Run all tests
npm test

# Run a specific test file
npx vitest run tests/path/to/test.test.ts

# Run tests in watch mode
npm run test:watch
```

Tests use [Vitest](https://vitest.dev/). Follow the existing test patterns in `tests/` when adding new tests.

## Making Changes

### Pull Request Process

1. **Fork** the repository and create a feature branch from `main`.
2. **Write tests** for any new functionality or bug fixes.
3. **Run the full test suite** (`npm test`) and ensure all tests pass.
4. **Build the project** (`npm run build`) and verify zero type errors.
5. **Submit a pull request** against `main` with a clear description of your changes.

### Code Style

- TypeScript with strict mode enabled
- ES modules (`"type": "module"` in package.json)
- Tests written with Vitest
- Follow existing patterns in the codebase -- consistency matters more than personal preference

### Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/) format:

- `feat:` new feature
- `fix:` bug fix
- `docs:` documentation changes
- `test:` adding or updating tests
- `chore:` maintenance tasks
- `security:` security-related changes

## CI Pipeline

Pull requests trigger automated checks:

- **Build and test** across Node.js 20 and 22
- **Semgrep SAST** scan with custom rules (`.semgrep/custom-rules.yml`)
- **Gitleaks** secret detection (`.gitleaks.toml`)
- **npm audit** for dependency vulnerabilities
- **License check** to ensure no GPL/AGPL/SSPL dependencies

All checks must pass before merging.

## Security Reporting

If you discover a security vulnerability, please report it responsibly:

- **Email:** support@kytheros.dev
- **Do not** open a public GitHub issue for security vulnerabilities.
- We will acknowledge receipt within 48 hours and work with you on a fix.

## Code Organization

```
src/
  server.ts          MCP server factory and tool registration
  config.ts          Centralized configuration (empirically optimized)
  indexing/           SQLite index manager, FTS5
  knowledge/          Knowledge evaluator, extractors, dedup, conflict resolution
  parsers/            Conversation file parsers (Claude Code, Codex, Cline, Aider, Gemini CLI)
  search/             BM25 search engine, query processor, result ranking
  storage/            SQLite/D1/Postgres storage backends
  tools/              MCP tool handler implementations
  extensions/         Embeddings, LLM extraction, vector search
  watcher/            File system watcher for live indexing
  utils/              Caching, response formatting, serialization

tests/               Test files (mirrors src/ structure)
```

## Questions?

Open a [GitHub Discussion](https://github.com/kytheros/strata/discussions) for questions about contributing, feature requests, or design discussions.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
