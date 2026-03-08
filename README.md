# strata-mcp

**Memory layer for AI coding assistants.**

Strata indexes conversations from five AI coding tools into a local SQLite database, extracts structured knowledge — decisions, solutions, error fixes, patterns, procedures — and makes it all searchable through 14 MCP tools. Think long-term memory for your AI pair programmer.

No cloud required. No memory caps. Runs entirely on your machine.

---

## Quick Start

Install globally and start searching in 30 seconds:

```bash
npm install -g strata-mcp
```

Add to Claude Code (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "strata": {
      "command": "npx",
      "args": ["-y", "strata-mcp"]
    }
  }
}
```

Restart Claude Code. Strata automatically indexes your conversation history on first run. Ask Claude: *"Search my history for Docker compose issues"* — it will call `search_history` and return ranked results from your past sessions.

---

## Why Strata

Every time you start a new AI coding session, your assistant forgets everything. Solutions you found last week, decisions you made last month, patterns you established across projects — all gone.

Strata fixes this. It watches your conversation history, extracts structured knowledge, and serves it back through MCP tools that your assistant can call automatically. Your AI remembers what you have built, how you debug, and what you have decided.

**How it compares:**

- **100% local** — no cloud dependency, no data leaves your machine
- **14 free tools** — competitors gate basic search behind paywalls
- **Full extraction pipeline** — not just storage, but knowledge extraction with entity graphs, procedure capture, and conflict resolution
- **5 AI tools supported** — Claude Code, Codex CLI, Aider, Cline, Gemini CLI
- **TOON format** — Token-Optimized Object Notation saves 30-60% on LLM context

---

## How It Works

```
Conversation files  -->  Parsers  -->  SQLite + FTS5 index
                                            |
                                   Knowledge Pipeline
                                            |
                          +--------+--------+--------+--------+
                          |        |        |        |        |
                      Entities  Decisions  Fixes  Patterns  Procedures
                          |        |        |        |        |
                          +--------+--------+--------+--------+
                                            |
                                     14 MCP Tools
                                            |
                                   Your AI Assistant
```

1. **Indexing** — Parsers read conversation files from each supported tool and store messages in SQLite with FTS5 full-text indexing.
2. **Extraction** — A heuristic scoring pipeline identifies decisions, solutions, error fixes, patterns, and learnings. Named entities (libraries, services, tools, languages, frameworks) are extracted into a cross-session entity graph.
3. **Procedures** — Step-by-step workflows are automatically captured and stored. Re-storing the same procedure merges updates.
4. **Deduplication** — Trigram Jaccard similarity (>0.90 threshold) prevents duplicate entries.
5. **Secret Sanitization** — API keys, tokens, and passwords are automatically redacted before storage.
6. **Serving** — 14 MCP tools expose everything to your AI assistant with confidence scoring, recency boosts, and project-aware ranking.

---

## Supported AI Tools

| Tool | Parser | Data Location |
|------|--------|---------------|
| Claude Code | `claude-code` | `~/.claude/projects/` |
| Codex CLI | `codex` | `~/.codex/sessions/` |
| Aider | `aider` | `.aider.chat.history.md` (per-project) |
| Cline | `cline` | VS Code `globalStorage/saoudrizwan.claude-dev/tasks/` |
| Gemini CLI | `gemini-cli` | `~/.gemini/tmp/` |

---

## MCP Tools (14 Free)

### Search and Discovery

| Tool | Description |
|------|-------------|
| `search_history` | FTS5 full-text search with BM25 ranking. Supports inline filters: `project:name`, `before:7d`, `tool:Bash`. Results include confidence bands. |
| `find_solutions` | Solution-biased search — results containing fix/resolve language score 1.5x higher. |
| `list_projects` | List all indexed projects with session counts, message counts, and date ranges. |
| `get_session_summary` | Structured session summary with metadata, topic, tools used, and conversation flow. |
| `get_project_context` | Comprehensive project context suitable for session-start injection. |
| `find_patterns` | Discover recurring topics, workflow patterns, and repeated issues across sessions. |

### Memory Management

| Tool | Description |
|------|-------------|
| `store_memory` | Store memories with 9 types: `decision`, `solution`, `error_fix`, `pattern`, `learning`, `procedure`, `fact`, `preference`, `episodic`. |
| `update_memory` | Partial update with full audit trail preserved. |
| `delete_memory` | Hard-delete with audit history preservation. |
| `memory_history` | View mutation history (add/update/delete) for any entry. |

### Knowledge Systems

| Tool | Description |
|------|-------------|
| `store_procedure` | Store step-by-step workflows. Auto-merges when re-storing the same title. |
| `find_procedures` | Search stored procedures and workflows. |
| `search_entities` | Query the cross-session entity graph — libraries, services, tools, languages, frameworks. |
| `ingest_conversation` | Push conversations from any agent into the full extraction pipeline. |

---

## Search Intelligence

Strata does not just find text matches. Every search result is scored through multiple ranking signals:

- **BM25 full-text ranking** — Standard information retrieval scoring via SQLite FTS5.
- **Confidence scoring** — Every result receives a confidence value (0.0-1.0) bucketed into high/medium/low bands.
- **Recency boosts** — Results from the last 7 days score +20%; last 30 days score +10%.
- **Project match boost** — Results from the current project score 1.3x higher.
- **Memory decay** — Auto-indexed entries older than 90 days score 0.85x; older than 180 days score 0.7x. Explicitly stored memories (via `store_memory`) are exempt from decay.

### Response Formats

All search tools support three output formats via the `format` parameter:

| Format | Description |
|--------|-------------|
| `concise` | TOON (Token-Optimized Object Notation) — saves 30-60% on LLM context window usage. |
| `standard` | Structured text with confidence bands. This is the default. |
| `detailed` | Full JSON for programmatic consumers and SDK integration. |

---

## CLI

```bash
strata-mcp                          # Start MCP server on stdio (default)
strata-mcp serve --port 3000        # Start HTTP/SSE server
strata-mcp search "docker compose"  # Search from terminal
strata-mcp status                   # Index statistics
strata-mcp migrate                  # Migrate legacy data to SQLite
strata-mcp activate <key>           # Activate Pro license
strata-mcp license                  # Show license status
strata-mcp embed                    # Generate vector embeddings (Pro)
```

### HTTP Transport

For non-stdio clients, Strata can serve over HTTP:

```bash
strata-mcp serve --port 3000
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `STRATA_LICENSE_KEY` | Pro/Team license key | _(free tier)_ |
| `STRATA_DEFAULT_USER` | Default user scope for multi-user setups | `default` |
| `STRATA_EXTRA_WATCH_DIRS` | Additional directories to watch for conversations | _(none)_ |
| `STRATA_DATA_DIR` | Data directory override | `~/.claude-history-mcp/` |
| `CLAUDE_HISTORY_API_URL` | Cloud sync server URL (Pro) | _(disabled)_ |
| `CLAUDE_HISTORY_API_KEY` | Cloud sync API key (Pro) | _(disabled)_ |
| `CLAUDE_HISTORY_TEAM_ID` | Team ID for shared sync (Team) | _(personal)_ |

---

## Requirements

- Node.js >= 18

---

## Pro Features

For power users who want deeper search and cross-machine sync. $9/month, works fully offline after activation.

| Feature | Description |
|---------|-------------|
| `semantic_search` tool | Hybrid FTS5 + vector cosine similarity via Reciprocal Rank Fusion. |
| `cloud_sync_push/pull/status` tools | Cross-machine sync via Supabase backend. |
| `get_analytics` tool | Local usage analytics — search patterns, tool usage, activity trends. |
| Vector embeddings | Gemini embedding provider for semantic matching. |
| LLM extraction | Deeper knowledge extraction using Gemini LLM. |

## Team Features

For teams sharing knowledge across developers. $19/user/month.

| Feature | Description |
|---------|-------------|
| Shared knowledge base | Cross-developer knowledge sharing and team-wide search. |
| Team sync | Bi-directional team knowledge synchronization. |
| Access control | Role-based permissions: admin, member, viewer. |

---

## License

MIT

The `src/extensions/` directory contains interface stubs and no-op implementations that allow the community edition to compile. The actual Pro/Team implementations live in separate packages (`@kytheros/strata-pro`, `@kytheros/strata-team`).
