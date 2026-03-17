# strata-mcp

Local memory layer for AI coding assistants. Strata indexes your conversations from Claude Code, Codex CLI, Aider, Cline, and Gemini CLI into a local SQLite database, then exposes MCP tools so your assistant can recall past decisions, solutions, and patterns across sessions.

**Semantic search included.** Add a free [Gemini API key](https://aistudio.google.com/apikey) to enable hybrid FTS5 + vector search with 3072-dimensional embeddings. Falls back to keyword search without it.

No cloud required. No memory caps. Everything stays on your machine.

**What makes Strata different:** Every knowledge entry passes through a [quality-gated evaluator pipeline](docs/evaluator-pipeline.md) before storage. Actionability, specificity, and relevance are checked deterministically. The result is a knowledge base that stays clean and auditable -- not a growing pile of everything.

---

## Quick Start (< 5 minutes)

### 1. Install

```bash
npm install -g strata-mcp
```

### 2. Register with Claude Code

```bash
claude mcp add strata -- npx strata-mcp
```

Or add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "strata": {
      "command": "npx",
      "args": ["strata-mcp"]
    }
  }
}
```

### 3. Restart Claude Code

The index builds automatically on first use.

### 4. Try it

Store a memory, then search for it:

```
You: "Remember that we use bcrypt with cost factor 12 for password hashing"

  -> store_memory({
       memory: "Use bcrypt with cost factor 12 for password hashing",
       type: "decision",
       tags: ["security", "bcrypt"]
     })
  -> Stored decision: "Use bcrypt with cost factor 12..."

You: "What did we decide about password hashing?"

  -> search_history({ query: "password hashing decision" })
  -> [HIGH] "Use bcrypt with cost factor 12 for password hashing"
```

### Verify

```bash
strata status
```

```
Strata v1.1.0
Database: ~/.strata/strata.db
Sessions: 142 | Documents: 3847 | Projects: 12
```

---

## Community Tools (9, free)

### Search and Discovery

| Tool | Description |
|------|-------------|
| `search_history` | FTS5 full-text search with BM25 ranking, auto-enhanced with vector search when Gemini is configured. Inline filters: `project:name`, `before:7d`, `after:30d`, `tool:Bash`. |
| `find_solutions` | Solution-biased search -- fix/resolve language scores 1.5x higher. Auto-enhanced with semantic search. |
| `semantic_search` | Hybrid FTS5 + vector cosine similarity via Reciprocal Rank Fusion. Finds results that keyword search misses. Requires `GEMINI_API_KEY`. |
| `list_projects` | All indexed projects with session counts, message counts, and date ranges. |
| `get_session_summary` | Structured session summary: metadata, topic, tools used, conversation flow. |
| `get_project_context` | Comprehensive project context with recent sessions, decisions, and patterns. |
| `find_patterns` | Recurring topics, workflow patterns, and repeated issues across sessions. |

### Memory Management

| Tool | Description |
|------|-------------|
| `store_memory` | Store memories with 9 types: decision, solution, error_fix, pattern, learning, procedure, fact, preference, episodic. |
| `delete_memory` | Hard-delete with audit history preservation. |

---

## How It Works

```
Conversation files  -->  Parsers  -->  SQLite + FTS5 index
                                             |
                                    Knowledge Pipeline
                                    (evaluate -> score -> dedup -> store)
                                             |
                              Decisions / Solutions / Fixes / Patterns
                                             |
                                       8 MCP Tools
                                             |
                                     Your AI Assistant
```

Every extracted knowledge entry passes through three quality gates before storage:

1. **Actionability** -- contains usable patterns (use, avoid, when...then, rate limits, error fixes)
2. **Specificity** -- has 2+ concrete details (numbers, versions, URLs, error codes, API refs)
3. **Relevance** -- about operational/technical topics (not weather, sports, humor)

Entries that fail any gate are rejected. This keeps the knowledge base clean and searchable. See [Evaluator Pipeline](docs/evaluator-pipeline.md) for the full specification with examples.

---

## Search Intelligence

Every search result is scored through multiple ranking signals:

- **BM25 full-text ranking** via SQLite FTS5 with Porter stemming
- **Vector cosine similarity** via Gemini `gemini-embedding-001` (3072-dim) with code-optimized task types
- **Reciprocal Rank Fusion** -- merges keyword and vector results for best-of-both retrieval
- **Recency boosts** -- last 7 days: 1.2x, last 30 days: 1.1x
- **Project match boost** -- results from the current project: 1.3x
- **Importance scoring** -- composite heuristic (type, language cues, frequency, explicit storage)
- **Memory decay** -- auto-indexed entries older than 90 days: 0.85x, older than 180 days: 0.7x (explicit memories exempt)
- **Confidence bands** -- results normalized to [0, 1] and bucketed into HIGH/MED/LOW

Vector search uses `CODE_RETRIEVAL_QUERY` task type for queries and `RETRIEVAL_DOCUMENT` for stored entries, optimizing Gemini's attention for code retrieval patterns.

---

## Supported AI Tools

| Tool | Data Location |
|------|---------------|
| Claude Code | `~/.claude/projects/` |
| Codex CLI | `~/.codex/sessions/` |
| Aider | `.aider.chat.history.md` (per-project) |
| Cline | VS Code `globalStorage/saoudrizwan.claude-dev/tasks/` |
| Gemini CLI | `~/.gemini/tmp/` |

Run `strata status` to see which tools are detected on your system.

---

## Pro Upgrade

For teams that need audit trails, entity intelligence, LLM extraction, and cross-machine sync.

| Feature | Description |
|---------|-------------|
| `memory_history` | Full audit trail of every knowledge mutation (add/update/delete) |
| `update_memory` | Partial updates with change tracking |
| `find_procedures` / `store_procedure` | Step-by-step workflow capture and search |
| `search_entities` | Cross-session entity graph (libraries, services, tools, frameworks) |
| `ingest_conversation` | Push conversations from any agent into the extraction pipeline |
| `cloud_sync_push/pull/status` | Encrypted cross-machine sync |
| `get_analytics` | Local usage analytics -- search patterns, tool usage, trends |
| `list_evidence_gaps` | Knowledge blind spots -- topics searched but never answered |
| LLM-powered extraction | Smart summaries via Gemini 2.5 Flash (uses same API key) |
| Local dashboard | Browser-based UI for knowledge exploration, settings, and maintenance |

### Activate

```bash
strata activate <license-key>
```

Or set `STRATA_LICENSE_KEY` in your MCP config:

```json
{
  "mcpServers": {
    "strata": {
      "command": "npx",
      "args": ["strata-mcp"],
      "env": {
        "STRATA_LICENSE_KEY": "your-key"
      }
    }
  }
}
```

Visit [strata.kytheros.dev/pricing](https://strata.kytheros.dev/pricing) for plans.

---

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `GEMINI_API_KEY` | Gemini API key for semantic search and embeddings. [Get one free](https://aistudio.google.com/apikey). Also reads from `~/.strata/config.json`. | _(FTS5 only)_ |
| `STRATA_DATA_DIR` | Database directory | `~/.strata/` |
| `STRATA_LICENSE_KEY` | Pro/Team license key | _(free tier)_ |
| `STRATA_DEFAULT_USER` | Default user scope | `default` |
| `STRATA_EXTRA_WATCH_DIRS` | Additional watch directories | _(none)_ |
| `NO_COLOR` | Disable colored CLI output | _(unset)_ |

You can also set the Gemini key in `~/.strata/config.json` instead of an environment variable:

```json
{
  "geminiApiKey": "AIzaSy..."
}
```

---

## CLI

| Command | Description |
|---------|-------------|
| `strata` | Start MCP server on stdio |
| `strata serve` | Start HTTP server on port 3000 (or `$PORT`) |
| `strata search <query>` | Search from the terminal |
| `strata store-memory <text> --type <t>` | Store a memory |
| `strata status` | Print index statistics |
| `strata init` | Set up hooks, skills, and CLAUDE.md |
| `strata activate <key>` | Activate a license |
| `strata --help` | Full usage |

---

## Requirements

- Node.js >= 18

No other system dependencies. SQLite is bundled via better-sqlite3.

---

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | System design, storage model, retrieval pipeline |
| [Evaluator Pipeline](docs/evaluator-pipeline.md) | Quality gates, accepted/rejected examples, importance scoring |
| [Provenance & Audit](docs/provenance.md) | knowledge_history table, tracing entries to origin |
| [Benchmarks](docs/benchmarks.md) | Retrieval quality metrics and methodology |
| [Claude Code Integration](docs/integration/claude-code.md) | Setup, tools, workflows |
| [MCP Client Integration](docs/integration/mcp-client.md) | stdio and HTTP transport, SDK examples |
| [Hooks and Skills](docs/HOOKS-AND-SKILLS.md) | Hook setup, skill definitions, agent integration |
| [Multi-Tool Support](docs/MULTI-TOOL.md) | Claude Code, Codex, Aider, Cline, Gemini CLI |
| [Configuration](docs/CONFIGURATION.md) | Environment variables, config constants |
| [Deployment](docs/DEPLOYMENT.md) | stdio, HTTP, Docker, Cloud Run |

---

## License

MIT
