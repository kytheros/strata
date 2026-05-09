#!/usr/bin/env sh
# Heavy pre-push / pre-flight gate. Mirrors the security and aws-template
# CI workflows by running Semgrep, TFLint, and Checkov via pinned Docker
# images, so a workstation can't drift behind CI's behavior.
#
# When this runs:
#   - .husky/pre-push calls it automatically when the about-to-push commit
#     count exceeds 5 (a "heavy push"). Smaller pushes get the lightweight
#     gate (npm test + gitleaks + npm audit) only.
#   - You can run it on demand: `task pre-flight` from templates/aws/, or
#     `./scripts/preflight-docker.sh` from the repo root.
#
# Why pinned Docker images:
#   Local installs of Semgrep / TFLint / Checkov drift in version, ruleset,
#   and behavior versus CI. Two of today's CI failures (one Semgrep false-
#   positive on cache.ts, six TFLint warnings) only surfaced after pushing.
#   Running the same images CI runs eliminates that drift class.
#
# Image versions are pinned to match the CI workflow envs:
#   - SEMGREP_IMAGE: floats with `returntocorp/semgrep` (CI uses this image
#     as a `container:` directly without an explicit tag). Pin a tag here
#     for reproducibility; bump when CI bumps.
#   - TFLINT_IMAGE: matches .github/workflows/aws-template-ci.yml's
#     TFLINT_VERSION (v0.51.1).
#   - CHECKOV_IMAGE: matches the same workflow's CHECKOV_VERSION (3.2.255).
#
# When CI bumps any of these, update the matching tag here AND update
# SECURITY.md §"Operator-PII Hygiene > Heavy gate" so the change is
# visible to anyone reviewing the gate posture.
set -e

SEMGREP_IMAGE="returntocorp/semgrep:1.95.0"
TFLINT_IMAGE="ghcr.io/terraform-linters/tflint:v0.51.1"
CHECKOV_IMAGE="bridgecrewio/checkov:3.2.255"

# ── 0. Sanity: Docker daemon must be up ─────────────────────────────────
if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker daemon is not running." >&2
  echo "       Start Docker Desktop (Windows/Mac) or 'sudo systemctl start docker' (Linux)." >&2
  echo "       To bypass this gate for one push: git push --no-verify." >&2
  exit 1
fi

# Pin the host repo path. `pwd -W` returns Windows-style paths under Git
# Bash, which Docker Desktop accepts; on Linux/Mac `pwd -W` errors so we
# fall back to plain `pwd`.
REPO_ROOT=$(pwd -W 2>/dev/null || pwd)

failures=""

# ── 1. Semgrep SAST ─────────────────────────────────────────────────────
# Mirrors .github/workflows/security.yml's semgrep step exactly.
echo "→ semgrep ($SEMGREP_IMAGE)"
if ! docker run --rm \
  -v "$REPO_ROOT:/src" \
  -w /src \
  "$SEMGREP_IMAGE" \
  semgrep \
    --config .semgrep/custom-rules.yml \
    --error --severity ERROR \
    --exclude node_modules \
    --exclude dist \
    --exclude '*.lock' \
    .
then
  failures="$failures semgrep"
fi

# ── 2. TFLint (templates/aws only) ──────────────────────────────────────
# Mirrors .github/workflows/aws-template-ci.yml's tflint step. tflint init
# downloads plugins (the AWS ruleset is several MB); the per-run cost is
# acceptable here because this is a heavy gate. To cache plugins across
# runs, mount $HOME/.tflint.d into the container.
if [ -d "templates/aws" ]; then
  echo "→ tflint ($TFLINT_IMAGE)"
  if ! docker run --rm \
    -v "$REPO_ROOT/templates/aws:/data" \
    -w /data \
    -e GITHUB_TOKEN="${GITHUB_TOKEN:-}" \
    --entrypoint sh \
    "$TFLINT_IMAGE" \
    -c "tflint --init && tflint --recursive --format compact"
  then
    failures="$failures tflint"
  fi
fi

# ── 3. Checkov IaC scan (templates/aws only) ────────────────────────────
# Mirrors .github/workflows/aws-template-ci.yml's checkov step.
if [ -d "templates/aws" ]; then
  echo "→ checkov ($CHECKOV_IMAGE)"
  if ! docker run --rm \
    -v "$REPO_ROOT/templates/aws:/tf" \
    "$CHECKOV_IMAGE" \
    --directory /tf \
    --framework terraform \
    --quiet \
    --compact \
    --soft-fail-on LOW \
    --download-external-modules false
  then
    failures="$failures checkov"
  fi
fi

# ── Summary ─────────────────────────────────────────────────────────────
if [ -n "$failures" ]; then
  echo "" >&2
  echo "Heavy gate FAILED in:$failures" >&2
  echo "  Fix the issues above, or bypass for one push: git push --no-verify" >&2
  exit 1
fi

echo "→ all heavy gates passed"
