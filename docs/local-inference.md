# Local LLM Inference with Gemma 4

Strata Pro's ingestion pipeline runs **three** LLM-powered stages per
conversation: knowledge extraction, conflict resolution, and session
summarization. By default these call Gemini 2.5 Flash over the network.

With one command, Strata can route all three to **Gemma 4** running locally
via Ollama. Gemini remains as a safety-net fallback if local validation fails.

## Why run locally

- **Zero per-call cost** after model download. Ingesting daily team
  conversations no longer accrues per-token charges.
- **No data leaves the machine.** Required for regulated environments
  (healthcare, defense, legal).
- **Lower latency.** No network round-trip per call.
- **Offline.** Strata continues to extract knowledge without internet.

## Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| Ollama | 0.5.0+ | latest |
| Disk for gemma4:e4b | 3.5 GB | 3.5 GB |
| Disk for gemma4:e2b | 1.8 GB | 1.8 GB |
| RAM | 8 GB | 16 GB |
| GPU | none (CPU works) | 4+ GB VRAM (3-10x faster) |

## Setup (one command)

```bash
# 1. Install Ollama from https://ollama.com (one-time)

# 2. Run the Strata setup command:
strata distill setup

# 3. Verify the pipeline works:
strata distill test
```

`strata distill setup` does three things:

1. Probes `http://localhost:11434/api/tags` to confirm Ollama is running.
2. Pulls `gemma4:e4b` and `gemma4:e2b` via `ollama pull` (skip with `--skip-pull`
   if already staged).
3. Writes the distillation block to `~/.strata/config.json`.

## Configuration reference

The setup command writes this block to `~/.strata/config.json`:

```json
{
  "distillation": {
    "enabled": true,
    "localUrl": "http://localhost:11434",
    "extractionModel": "gemma4:e4b",
    "summarizationModel": "gemma4:e4b",
    "conflictResolutionModel": "gemma4:e2b",
    "fallback": "gemini"
  }
}
```

### Field reference

- `enabled` — master switch. Set to `false` to revert to frontier-only.
- `localUrl` — Ollama endpoint. Must be localhost or 127.0.0.1 (SSRF guard).
- `extractionModel` — used for `enhancedExtract` (one call per session).
- `summarizationModel` — used for `smartSummarize` (one call per session).
- `conflictResolutionModel` — used for per-entry classification. Smaller
  variant (E2B) recommended for speed — this stage runs N times per
  ingest where N = extracted entries.
- `fallback` — which frontier provider to fall back to when local validation
  fails. Currently only `gemini` is supported.

### Alternate models

Any Ollama-compatible model that produces JSON works. To override:

```json
{
  "distillation": {
    "enabled": true,
    "extractionModel": "qwen3:7b-instruct",
    "summarizationModel": "llama3.2:8b",
    "conflictResolutionModel": "gemma4:e2b"
  }
}
```

Run `strata distill test` after changing to verify the new model produces
valid JSON for each stage.

## How the hybrid fallback works

Every call attempts the local model first, then validates the output as JSON
matching the expected schema:

| Stage | Validator |
|-------|-----------|
| Extraction | has `entries` array |
| Summarization | has non-empty `topic` string |
| Conflict resolution | has `shouldAdd` boolean and `actions` array |

If the local model returns invalid output, times out, or errors, Strata
transparently retries on Gemini. The fallback is logged but does not surface
to the caller.

## Troubleshooting

### "Ollama not reachable"

- Is Ollama installed? Run `ollama --version`.
- Is it running? Run `ollama serve` in a separate terminal.
- Firewall blocking localhost? Check `curl http://localhost:11434/api/tags`.

### "Model not found: gemma4:e4b"

- Pull manually: `ollama pull gemma4:e4b`.
- Old Ollama? Upgrade to 0.5.0+.

### Local output is always failing validation

- Run `strata distill test` to see the actual model output.
- Small models sometimes add markdown fences around JSON. The validator
  handles that; if it still fails, check if the model produced prose
  instead of JSON.
- Consider a larger variant: `gemma4:e4b` vs `gemma4:e2b`.

## Performance comparison

Measured on a 13-session ingest (1 LongMemEval question) with identical
input on a Mac M2 Max with 32GB RAM:

| Stage | Gemini (network) | Gemma 4 E4B (local) | Speedup |
|-------|------------------|---------------------|---------|
| Extraction (per session) | ~4 s | ~1.5 s | 2.7x |
| Conflict resolution (per entry) | ~1 s | ~0.3 s | 3.3x |
| Summarization (per session) | ~3 s | ~1.2 s | 2.5x |

Numbers vary with hardware. GPUs produce a larger speedup. The quality
thresholds in `evals/local-inference-quality/` guarantee Gemma 4 stays
within 85% of Gemini's extraction quality, 80% of summarization, and
90% of conflict resolution.

## Performance tuning

### Parallel request handling

Ollama defaults to processing one request at a time (`OLLAMA_NUM_PARALLEL=1`).
Strata sends conflict-resolution calls in parallel, which queue up and may
timeout on the default setting.

**Recommended:** Set parallel slots to 4:

```bash
# Linux/macOS
export OLLAMA_NUM_PARALLEL=4

# Windows (persists across restarts)
setx OLLAMA_NUM_PARALLEL 4
# Then restart Ollama
```

### VRAM considerations

Strata uses two model sizes by default:
- **gemma4:e4b** (9.6 GB) for extraction and summarization
- **gemma4:e2b** (7.2 GB) for conflict resolution

Both models together need ~22 GB VRAM. If your GPU has ≤16 GB, Ollama must
evict one model to load the other on every switch, adding ~12 seconds per swap.

**Fix for ≤16 GB GPUs:** Use the same model for all three stages:

```json
// ~/.strata/config.json
{
  "distillation": {
    "enabled": true,
    "extractionModel": "gemma4:e4b",
    "summarizationModel": "gemma4:e4b",
    "conflictResolutionModel": "gemma4:e4b"
  }
}
```

### Timeout settings

Extraction prompts on long conversations (50+ turns) can take 60-120 seconds
on consumer GPUs. The default timeout is 180 seconds. If you see extraction
falling back to heuristic mode, check that:

1. Ollama is running and the model is pulled (`ollama list`)
2. `OLLAMA_NUM_PARALLEL` is set to at least 4
3. Your GPU has enough free VRAM (check `nvidia-smi`)
