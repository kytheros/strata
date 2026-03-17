# Strata Configuration Reference

This document covers all configuration options for Strata: environment variables, MCP server setup, CLI flags, internal config constants, file locations, and cloud sync settings.

---

## Table of Contents

1. [Environment Variables](#1-environment-variables)
2. [MCP Server Configuration](#2-mcp-server-configuration)
3. [CLI Flags](#3-cli-flags)
4. [Config Constants](#4-config-constants)
5. [File Locations](#5-file-locations)
6. [Cloud Sync Configuration](#6-cloud-sync-configuration)

---

## 1. Environment Variables

All environment variables are read at runtime. None are required for basic operation.

| Variable | Default | Description |
|----------|---------|-------------|
| `STRATA_DATA_DIR` | `~/.strata/` | Root directory for Strata's database, summaries, and caches |
| `STRATA_LICENSE_KEY` | -- | License key for Pro/Team features (alternative to `strata activate`) |
| `STRATA_DEFAULT_USER` | `"default"` | Default user scope for multi-user setups |
| `STRATA_API_URL` | `""` | Cloud sync API endpoint (Pro) |
| `STRATA_API_KEY` | `""` | Cloud sync API key (Pro) |
| `STRATA_TEAM_ID` | `""` | Team identifier for team sync (Team tier) |
| `STRATA_EXTRA_WATCH_DIRS` | `""` | Additional watch directories (see below) |
| `STRATA_CONFLICT_RESOLUTION` | `"1"` | Set to `"0"` to disable LLM conflict resolution |
| `NO_COLOR` | -- | Disable colored CLI output (any value) |
| `PORT` | `3000` | HTTP server port for `strata serve` |

### STRATA_DATA_DIR

Overrides the default data directory (`~/.strata/`). All files -- the SQLite database, summary cache, recurring issues, sync state -- are stored relative to this directory.

**Source:** `src/storage/database.ts`, line 16:

```typescript
export function getDataDir(): string {
  return process.env.STRATA_DATA_DIR || DEFAULT_DATA_DIR;
}
```

### STRATA_EXTRA_WATCH_DIRS

Comma-separated list of additional directories to watch for conversation files. Each entry is `path:extension`.

```bash
export STRATA_EXTRA_WATCH_DIRS="/home/user/custom-tool/sessions:.jsonl,/tmp/ai-logs:.json"
```

**Source:** `src/config.ts`, line 79:

```typescript
get extraWatchDirs(): string[] {
  const raw = process.env.STRATA_EXTRA_WATCH_DIRS || "";
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
}
```

On Windows, the last colon is used as the separator to handle drive letters (e.g., `C:\path:.ext`).

### STRATA_CONFLICT_RESOLUTION

Killswitch for LLM-based conflict resolution. Set to `"0"` to disable. When disabled, new entries are written directly with only trigram-based dedup.

**Source:** `src/knowledge/conflict-resolver.ts`, line 50:

```typescript
if (process.env.STRATA_CONFLICT_RESOLUTION === "0") {
  return FALLBACK_RESOLUTION;
}
```

---

## 2. MCP Server Configuration

Strata runs as an MCP server over stdio (default) or HTTP.

### Claude Code (Recommended)

Add Strata as an MCP server using the Claude Code CLI:

```bash
claude mcp add strata -- npx -y strata-mcp@latest
```

Or for a local development install:

```bash
claude mcp add strata -- node /path/to/strata/dist/cli.js
```

This writes to `~/.claude/settings.json` or your project's `.mcp.json`.

### Manual MCP Configuration

Add to your MCP client's configuration file:

```json
{
  "mcpServers": {
    "strata": {
      "command": "npx",
      "args": ["-y", "strata-mcp@latest"],
      "env": {
        "STRATA_DATA_DIR": "/custom/path"
      }
    }
  }
}
```

### Cursor

In Cursor's settings, add an MCP server:

```json
{
  "mcpServers": {
    "strata": {
      "command": "npx",
      "args": ["-y", "strata-mcp@latest"]
    }
  }
}
```

### HTTP Transport

Start an HTTP server instead of stdio:

```bash
strata serve --port 3000
```

Or set the port via environment variable:

```bash
PORT=8080 strata serve
```

**Source:** `src/cli.ts`, line 520. The HTTP transport is implemented in `src/transports/http-transport.ts`.

### Hook Registration

To enable automatic context injection and knowledge extraction, register hooks in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "strata hook session-start"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "strata hook session-stop"
          }
        ]
      }
    ],
    "SubagentStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "strata hook subagent-start"
          }
        ]
      }
    ]
  }
}
```

Or use the automated setup:

```bash
strata init
```

This command creates hooks, slash command skills, and CLAUDE.md sections. Use `--force` to overwrite existing configuration.

---

## 3. CLI Flags

**Source:** `src/cli.ts`

### Global Flags

| Flag | Description |
|------|-------------|
| `--version`, `-v` | Print version number |
| `--help`, `-h` | Print usage information |
| `--no-color` | Disable colored output (also: `NO_COLOR` env var) |

### Subcommands

#### `strata` (no arguments)

Start the MCP server on stdio. This is the default behavior.

#### `strata serve`

Start an HTTP server for the MCP protocol.

| Flag | Default | Description |
|------|---------|-------------|
| `--port <n>` | 3000 (or `$PORT`) | HTTP port to listen on |

#### `strata search <query>`

Search conversation history from the command line.

| Flag | Default | Description |
|------|---------|-------------|
| `--limit <n>` | 20 | Maximum results |
| `--project <name>` | -- | Filter by project |
| `--tool <name>` | -- | Filter by tool (claude-code, codex, aider) |
| `--json` | false | Output results as JSON |

#### `strata find-procedures <query>`

Search for procedure entries. Requires Strata Pro.

| Flag | Default | Description |
|------|---------|-------------|
| `--project <name>` | -- | Filter by project |
| `--json` | false | Output as JSON |

#### `strata entities [query]`

Search the entity graph. Requires Strata Pro.

| Flag | Default | Description |
|------|---------|-------------|
| `--type <type>` | -- | Filter by entity type (library, service, tool, etc.) |
| `--project <name>` | -- | Filter by project |
| `--limit <n>` | 10 | Maximum results |
| `--json` | false | Output as JSON |

#### `strata store-memory <text>`

Store an explicit memory from the command line.

| Flag | Default | Description |
|------|---------|-------------|
| `--type <type>` | -- | **Required.** Memory type: decision, solution, error_fix, pattern, learning, procedure, fact, preference, episodic |
| `--tags <tags>` | -- | Comma-separated tags |
| `--project <name>` | `"global"` | Project scope |
| `--json` | false | Output as JSON |

#### `strata activate <key>`

Activate a license. Supports two key formats:

- **Polar keys** (start with `STRATA-` or contain `pol_lic_`): Downloads and installs the licensed edition
- **JWT keys** (start with `eyJ`): Validates and saves the license locally

| Flag | Default | Description |
|------|---------|-------------|
| `--binary` | false | Download standalone binary instead of tarball |
| `--platform <id>` | auto-detect | Override platform (linux-x64, darwin-arm64, darwin-x64, win-x64) |

#### `strata update`

Check for and install newer versions. Reads the saved Polar key from `~/.strata/license.key` and install config from `~/.strata/config.json`.

#### `strata license`

Show current license status: tier, email, features, expiration date.

#### `strata embed`

Generate embeddings for vector search. Requires Strata Pro.

#### `strata init`

Set up Strata in the current project: creates hooks, skills, and CLAUDE.md sections.

| Flag | Default | Description |
|------|---------|-------------|
| `--force` | false | Overwrite existing skills, hooks, and CLAUDE.md sections |

#### `strata migrate`

Migrate legacy data (JSON/msgpack files) to SQLite.

| Flag | Default | Description |
|------|---------|-------------|
| `--force` | false | Re-run migration even if already completed |

#### `strata status`

Print index statistics: database path, session count, document count, project count, and detected parsers.

#### `strata hook <name>`

Run a specific hook. Used internally by the hook registration system.

Available hooks: `session-start`, `session-stop`, `subagent-start`.

---

## 4. Config Constants

**Source:** `src/config.ts`

All configuration constants are defined in the `CONFIG` object. These are compile-time constants, not runtime-configurable (with the exception of `dataDir` which respects `STRATA_DATA_DIR`).

### BM25 Parameters

| Constant | Value | Description |
|----------|-------|-------------|
| `bm25.k1` | 1.2 | Term saturation parameter |
| `bm25.b` | 0.75 | Document length normalization |

Note: These constants are defined for reference but FTS5 uses its own internal BM25 implementation with the `porter unicode61` tokenizer.

### Search Defaults

| Constant | Value | Description |
|----------|-------|-------------|
| `search.defaultLimit` | 20 | Default result limit |
| `search.maxLimit` | 100 | Maximum allowed result limit |
| `search.contextLines` | 3 | Context lines for surrounding messages |
| `search.recencyBoost7d` | 1.2 | Boost multiplier for results <= 7 days old |
| `search.recencyBoost30d` | 1.1 | Boost multiplier for results <= 30 days old |
| `search.projectMatchBoost` | 1.3 | Boost multiplier when result project matches current |
| `search.rrfK` | 60 | Reciprocal Rank Fusion constant (higher = less weight on rank position) |
| `search.decayPenalty90d` | 0.85 | Decay multiplier for auto-indexed entries > 90 days (Pro only) |
| `search.decayPenalty180d` | 0.7 | Decay multiplier for auto-indexed entries > 180 days (Pro only) |
| `search.confidenceHighThreshold` | 0.6 | Confidence >= this is labeled "high" |
| `search.confidenceMediumThreshold` | 0.3 | Confidence >= this is labeled "medium" |
| `search.lowConfidenceThreshold` | 1.5 | Absolute score below which results trigger gap recording |

### Indexing Parameters

| Constant | Value | Description |
|----------|-------|-------------|
| `indexing.chunkSize` | 500 | Target tokens per chunk |
| `indexing.chunkOverlap` | 50 | Token overlap between adjacent chunks |
| `indexing.maxChunksPerSession` | 200 | Maximum chunks per session |

### File Watcher

| Constant | Value | Description |
|----------|-------|-------------|
| `watcher.debounceMs` | 5000 | Milliseconds to wait after last file change before indexing |
| `watcher.staleSessionMinutes` | 5 | Minutes since last modification before a session is considered ended |

### Importance Scoring

| Constant | Value | Description |
|----------|-------|-------------|
| `importance.typeWeight` | 0.35 | Weight of knowledge type signal |
| `importance.languageWeight` | 0.20 | Weight of language marker signal |
| `importance.frequencyWeight` | 0.35 | Weight of cross-session frequency signal |
| `importance.explicitWeight` | 0.10 | Weight of explicit storage signal |
| `importance.boostMax` | 0.5 | Max boost multiplier in search ranking. Formula: `score *= (1.0 + importance * boostMax)`. Set to 0 to disable. |

The four weights sum to 1.0.

### Learning Synthesis

| Constant | Value | Description |
|----------|-------|-------------|
| `learning.similarityThreshold` | 0.6 | Minimum Jaccard similarity for clustering |
| `learning.promotionThreshold` | 10 | Minimum cluster score to promote to a learning |
| `learning.maxLearningsPerProject` | 10 | Maximum learnings per project |
| `learning.maxLearningLength` | 120 | Maximum characters per learning summary |
| `learning.memoryLineBudget` | 200 | Maximum lines in generated MEMORY.md files |

### Evidence Gap Tracking

| Constant | Value | Description |
|----------|-------|-------------|
| `gaps.enabled` | true | Whether gap tracking is active |
| `gaps.resolutionThreshold` | 0.4 | Minimum Jaccard similarity for gap resolution |
| `gaps.maxPerProject` | 100 | Maximum open gaps per project+user |
| `gaps.pruneAfterDays` | 90 | Auto-prune unresolved gaps older than this |

### Cloud Sync

| Constant | Source | Description |
|----------|--------|-------------|
| `cloud.apiUrl` | `STRATA_API_URL` | Cloud sync API endpoint |
| `cloud.apiKey` | `STRATA_API_KEY` | Cloud sync API key |
| `cloud.teamId` | `STRATA_TEAM_ID` | Team identifier |

---

## 5. File Locations

### Default Data Directory

```
~/.strata/
```

Override with `STRATA_DATA_DIR` environment variable.

### File Map

| Path | Description | Source |
|------|-------------|--------|
| `~/.strata/strata.db` | Main SQLite database (WAL mode) | `src/storage/database.ts`, line 22 |
| `~/.strata/summaries/{sessionId}.json` | Cached session summaries | `src/knowledge/session-summarizer.ts`, line 78 |
| `~/.strata/recurring-issues.json` | Recurring issue cache | `src/knowledge/learning-synthesizer.ts`, line 207 |
| `~/.strata/sync-state.json` | Cloud sync state | `src/config.ts`, line 91 |
| `~/.strata/license.key` | Saved license key | `src/cli.ts`, line 343 |
| `~/.strata/config.json` | Install configuration (tier, version, format, platform) | Used by `strata update` |
| `~/.strata/knowledge.json` | Legacy knowledge file (pre-SQLite) | `src/config.ts`, line 21 |
| `~/.strata/index.msgpack` | Legacy index file (pre-SQLite) | `src/config.ts`, line 18 |
| `~/.strata/meta.json` | Legacy metadata | `src/config.ts`, line 25 |

### Source Data Locations

Strata reads conversation data from these tool-specific directories:

| Tool | Directory | Ref |
|------|-----------|-----|
| Claude Code | `~/.claude/projects/` | `src/config.ts`, line 10 |
| Claude Code history | `~/.claude/history.jsonl` | `src/config.ts`, line 7 |
| Codex CLI | `~/.codex/sessions/` | `src/watcher/file-watcher.ts`, line 40 |
| Cline (macOS) | `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/` | `src/watcher/file-watcher.ts`, line 189 |
| Cline (Linux) | `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/` | `src/watcher/file-watcher.ts`, line 192 |
| Cline (Windows) | `%APPDATA%/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/` | `src/watcher/file-watcher.ts`, line 187 |
| Gemini CLI (Pro) | `~/.gemini/tmp/` | `src/watcher/file-watcher.ts`, line 58 |
| Aider (Pro) | Project-level `.aider.chat.history.md` files | Discovered by parser |

### Changing the Data Directory

Set the `STRATA_DATA_DIR` environment variable before starting Strata:

```bash
export STRATA_DATA_DIR=/path/to/custom/strata
strata status
```

Or in MCP configuration:

```json
{
  "mcpServers": {
    "strata": {
      "command": "npx",
      "args": ["-y", "strata-mcp@latest"],
      "env": {
        "STRATA_DATA_DIR": "/path/to/custom/strata"
      }
    }
  }
}
```

The directory is created automatically if it does not exist (`src/storage/database.ts`, line 36).

---

## 6. Cloud Sync Configuration

Cloud sync is a Pro feature that synchronizes knowledge entries with a remote API.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `STRATA_API_URL` | Yes | Base URL of the sync API endpoint |
| `STRATA_API_KEY` | Yes | Authentication key for the sync API |
| `STRATA_TEAM_ID` | For Team tier | Team identifier for shared knowledge |

### Setup

```bash
export STRATA_API_URL="https://api.strata.kytheros.dev"
export STRATA_API_KEY="your-api-key"
export STRATA_TEAM_ID="your-team-id"  # Team tier only
```

Or in MCP configuration:

```json
{
  "mcpServers": {
    "strata": {
      "command": "npx",
      "args": ["-y", "strata-mcp@latest"],
      "env": {
        "STRATA_API_URL": "https://api.strata.kytheros.dev",
        "STRATA_API_KEY": "your-api-key",
        "STRATA_TEAM_ID": "your-team-id"
      }
    }
  }
}
```

Sync state is persisted at `~/.strata/sync-state.json` (`src/config.ts`, line 91) to track what has been uploaded and enable incremental sync.

---

## Cross-References

- For architecture details, see [ARCHITECTURE.md](./ARCHITECTURE.md)
- For tool-by-tool documentation, see [TOOLS.md](./TOOLS.md)
