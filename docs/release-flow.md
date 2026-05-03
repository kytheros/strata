# Release Flow

How to cut a `strata-mcp` release. The CI pipeline (`.github/workflows/publish.yml`) is the source of truth; this doc is the human-readable companion plus the rationale.

## When to release

After a coherent unit of work lands on `main`:

- A complete phase of a multi-ticket plan
- A bugfix worth shipping out-of-band
- A security patch (no soak window — ship immediately)

`strata-mcp` follows [Semantic Versioning](https://semver.org/):

| Change | Version bump | Examples |
|---|---|---|
| Bug fix, no API change | PATCH (2.1.0 → 2.1.1) | Pre-existing flake fix, doc typo, internal refactor |
| Additive feature, no breaking change | MINOR (2.1.0 → 2.2.0) | New MCP tool, new CLI subcommand, new config key with safe default |
| Breaking change to a public surface | MAJOR (2.1.0 → 3.0.0) | Removed/renamed MCP tool, changed default behavior visible to users without opt-in |

If a feature is gated behind an off-by-default flag, it's MINOR — the user-visible surface is unchanged until they opt in.

## What's irreversible

The git side is fully reversible. Branches, tags, force-pushes — all recoverable.

The npm side is **not**. Once `strata-mcp@X.Y.Z` is published:
- The version number is permanently bound to whatever tarball was uploaded.
- You cannot republish the same version with different content.
- You can `npm unpublish` within 72 hours, but it's noisy and breaks downstream installs.
- The standard recovery is "ship X.Y.Z+1 with the fix" — not undo.

This is why the pack-and-test step exists.

## Pre-tag checklist (mandatory)

Before pushing the version tag that triggers `npm publish`:

### 1. Phase 1 wrap-up gates pass

- [ ] `npm test` from `strata/` — full unit + integration suite green (note pre-existing flakes, but no new failures)
- [ ] All frozen evals (NPC + Community) score ≥ ship-gate
- [ ] `strata-web` build clean (if docs were touched)
- [ ] `code-reviewer` agent run over the new commits — verdict is SHIP or SHIP-WITH-FOLLOWUPS

### 2. Pack-and-test smoke (catches CLI surface regressions)

This step exists specifically because integration tests bypass CLI arg parsing and the help-text registry — they call library functions directly. A pack-and-test exercises the same code path users will hit.

Run from the strata sub-repo (`E:/strata/strata` on dev machines):

```bash
# Build fresh dist (CI does this — but locally the dist may be stale)
npm run build

# Pack — creates strata-mcp-X.Y.Z.tgz
npm pack

# Install in a scratch dir
SCRATCH=$(mktemp -d)
cd "$SCRATCH"
npm init -y >/dev/null
npm install /path/to/strata-mcp-X.Y.Z.tgz

# Smoke the CLI surface
./node_modules/.bin/strata --version              # reports X.Y.Z
./node_modules/.bin/strata --help                 # lists all subcommands including any new ones
./node_modules/.bin/strata <new-subcommand> --help  # specific to whatever you added
```

For each new CLI flag or subcommand introduced in this release, exercise it explicitly. The pack-and-test is the only test that exercises:

- The arg parser (`parseArgs()` recognizing the new flag)
- The help-text registry (the new subcommand advertised in `--help`)
- The packaged file set (every runtime file in `package.json` `files`)
- Native rebuild artifacts in the published shape

CI re-runs this step automatically before `npm publish` (see `publish.yml`), but doing it locally first avoids tagging a broken release.

### 3. CHANGELOG and version bump

- [ ] `CHANGELOG.md` has an entry for the new version (Keep a Changelog format)
- [ ] `package.json` `version` field bumped
- [ ] Both committed in one `chore: release X.Y.Z` commit

### 4. Push commits, wait for CI on main

- [ ] `git push origin main` — pushes commits, triggers `ci.yml`
- [ ] CI on main is green before tagging — confirms the release commits work in clean CI

## Tag and publish

```bash
# Annotated tag for traceability
git tag -a vX.Y.Z -m "Release X.Y.Z"
git push origin vX.Y.Z
```

Pushing the tag triggers `publish.yml`:
1. Fresh checkout of the tagged commit
2. `npm ci` (clean install, ignore-scripts mode)
3. `npm run rebuild:native` (better-sqlite3, esbuild, sharp, onnxruntime-node, etc.)
4. `npm run build`
5. `npm test`
6. **Pack-and-test smoke** — fail-stop before publish if regressions surface
7. `npm publish` to npmjs.org

Watch the workflow run on GitHub Actions. If pack-and-test fails, the publish aborts — fix the code, push, and re-tag (e.g. delete `vX.Y.Z`, push a fix commit, retag).

## After publish

- [ ] `npm view strata-mcp@X.Y.Z` shows the new version
- [ ] `npm install strata-mcp@latest` in a scratch dir resolves to X.Y.Z
- [ ] Open a follow-up commit if anything in `docs/`, the README's version-aware sections, or `strata-web` needs updating with the live version

## Rollback

If a published version has a bug:

1. **Hotfix path (preferred):** ship `X.Y.Z+1` with the fix. Users on a `^X.Y.Z` range upgrade automatically; users pinned to `X.Y.Z` stay there with the bug until they upgrade.
2. **Deprecate path (additive):** `npm deprecate strata-mcp@X.Y.Z "Use X.Y.Z+1 — fixes <issue>"`. The version stays installable but emits a warning.
3. **Unpublish path (last resort, ≤72h):** `npm unpublish strata-mcp@X.Y.Z`. Breaks downstream installs that pinned to that version. Reserve for security incidents only.

## Why pack-and-test exists in this doc

A real regression slipped past the integration tests in TIRQDP-1.9 (commit `2f693c8`):

- The new `--rebuild-turns` flag was not registered in `parseArgs()` — the parser silently dropped it
- `strata --help` did not advertise the new `index` subcommand

The integration test (`tests/integration/rebuild-turns-cli.test.ts`) passed because it imported `runRebuildTurns()` directly, bypassing the CLI dispatch. Without pack-and-test, both bugs would have shipped to npm. The `useTirQdp=false` default would have prevented user-visible breakage, but the new opt-in path would have been undiscoverable and broken on first invocation.

Both bugs were caught by a manual pack-and-test before the v2.1.0 tag was pushed (commit `584d881`). The CI step in `publish.yml` now runs the same check on every release, so future regressions of the same shape can't escape.
