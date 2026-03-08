#!/usr/bin/env bash
#
# Capture golden fixture files from real AI coding tools.
#
# This script runs each tool in a Docker container with a simple prompt,
# then copies the conversation history files to tests/fixtures/golden/.
#
# Prerequisites:
#   - Docker installed and running
#   - API keys set as environment variables:
#     OPENAI_API_KEY    — for Codex CLI
#     GOOGLE_API_KEY    — for Gemini CLI
#     ANTHROPIC_API_KEY — for Cline (via VS Code headless, complex)
#
# Usage:
#   OPENAI_API_KEY=sk-... GOOGLE_API_KEY=... ./tests/fixtures/capture-golden.sh
#
# Each tool generates a short conversation (~1 turn) to minimize API costs.
# The captured files replace the synthetic golden fixtures with real data.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GOLDEN_DIR="$SCRIPT_DIR/golden"

# ── Codex CLI ────────────────────────────────────────────────────────────

capture_codex() {
  if [ -z "${OPENAI_API_KEY:-}" ]; then
    echo "⚠ Skipping Codex CLI (OPENAI_API_KEY not set)"
    return
  fi

  echo "▶ Capturing Codex CLI conversation..."

  docker run --rm \
    -e OPENAI_API_KEY="$OPENAI_API_KEY" \
    -v "$GOLDEN_DIR/codex:/output" \
    node:20-slim bash -c '
      npm install -g @openai/codex 2>/dev/null
      mkdir -p /tmp/project && cd /tmp/project
      echo "console.log(\"hello\");" > index.js

      # Run codex with a simple prompt (non-interactive, auto-approve)
      echo "Add a comment to index.js explaining what it does" | codex --approval-mode full-auto 2>/dev/null || true

      # Copy session files to output
      if [ -d "$HOME/.codex/sessions" ]; then
        cp -r "$HOME/.codex/sessions" /output/
        echo "✓ Codex sessions captured"
      else
        echo "✗ No Codex session files found"
      fi
    '
}

# ── Gemini CLI ───────────────────────────────────────────────────────────

capture_gemini() {
  if [ -z "${GOOGLE_API_KEY:-}" ]; then
    echo "⚠ Skipping Gemini CLI (GOOGLE_API_KEY not set)"
    return
  fi

  echo "▶ Capturing Gemini CLI conversation..."

  docker run --rm \
    -e GOOGLE_API_KEY="$GOOGLE_API_KEY" \
    -v "$GOLDEN_DIR/gemini:/output" \
    node:20-slim bash -c '
      npm install -g @anthropic-ai/gemini-cli 2>/dev/null || npm install -g @anthropic-ai/claude-code-gemini 2>/dev/null || true
      mkdir -p /tmp/project && cd /tmp/project
      echo "console.log(\"hello\");" > index.js

      # Run gemini with a simple prompt
      echo "What does index.js do?" | gemini 2>/dev/null || true

      # Copy checkpoint files to output
      if [ -d "$HOME/.gemini/tmp" ]; then
        cp -r "$HOME/.gemini/tmp/"* /output/ 2>/dev/null || true
        echo "✓ Gemini checkpoints captured"
      else
        echo "✗ No Gemini checkpoint files found"
      fi
    '
}

# ── Main ─────────────────────────────────────────────────────────────────

echo "=== Golden Fixture Capture ==="
echo "Output: $GOLDEN_DIR"
echo ""

capture_codex
capture_gemini

echo ""
echo "=== Done ==="
echo "Note: Cline requires VS Code and cannot be easily automated in Docker."
echo "To capture Cline fixtures, use the extension manually and copy:"
echo "  %APPDATA%/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/<id>/api_conversation_history.json"
echo "  → tests/fixtures/golden/cline/<id>/api_conversation_history.json"
