#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"

# ---------------------------------------------------------------------------
# 1. Setup venv if needed
# ---------------------------------------------------------------------------
if [ ! -d "$VENV_DIR" ]; then
    echo "Creating virtual environment..."
    python3 -m venv "$VENV_DIR"
fi

# Activate venv (cross-platform)
if [ -f "$VENV_DIR/bin/activate" ]; then
    source "$VENV_DIR/bin/activate"
elif [ -f "$VENV_DIR/Scripts/activate" ]; then
    source "$VENV_DIR/Scripts/activate"
else
    echo "Error: Cannot find venv activate script" >&2
    exit 1
fi

# Install deps if needed (check for agents_memory as marker)
if ! python -c "import agents_memory" 2>/dev/null; then
    echo "Installing dependencies..."
    pip install --quiet -r "$SCRIPT_DIR/requirements.txt"
fi

# Install strata-memory SDK from local path if available
if [ -d "$SCRIPT_DIR/../../../strata-py" ]; then
    if ! python -c "import strata" 2>/dev/null; then
        echo "Installing strata-memory SDK from local path..."
        pip install --quiet -e "$SCRIPT_DIR/../../../strata-py"
    fi
fi

# Install google-genai if needed
if ! python -c "from google import genai" 2>/dev/null; then
    echo "Installing google-genai..."
    pip install --quiet "google-genai>=1.0.0"
fi

# ---------------------------------------------------------------------------
# 2. Check required env vars
# ---------------------------------------------------------------------------
if [ -z "${GEMINI_API_KEY:-}" ]; then
    echo "Error: GEMINI_API_KEY is required" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# 3. Parse arguments and run benchmark
# ---------------------------------------------------------------------------
export STRATA_DATA_DIR="${STRATA_DATA_DIR:-}"

# Default args
NUM_SAMPLES="${NUM_SAMPLES:-10}"
EXTRA_ARGS=()
HAS_NUM_SAMPLES=false
HAS_SKIP_JUDGE=false

for arg in "$@"; do
    case "$arg" in
        --num-samples)
            HAS_NUM_SAMPLES=true
            ;;
        --skip-judge)
            HAS_SKIP_JUDGE=true
            ;;
    esac
done

# Build command
CMD="python $SCRIPT_DIR/run_benchmark.py"

if [ "$HAS_NUM_SAMPLES" = false ]; then
    CMD="$CMD --num-samples $NUM_SAMPLES"
fi

# Pass through all arguments
exec $CMD "$@"
