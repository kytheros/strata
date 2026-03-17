# Integration: Claude Code

This guide covers setting up Strata as an MCP server for Claude Code. After setup, Claude Code can search your conversation history, store memories, find solutions, and recall project context automatically.

---

## Quick Setup (60 seconds)

### Option 1: CLI registration

```bash
npm install -g strata-mcp
claude mcp add strata -- npx strata-mcp
```

Restart Claude Code. Done.

### Option 2: Manual `.mcp.json` (project-level)

Create `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "strata": {
      "command": "npx",
      "args": ["strata-mcp"],
      "env": {}
    }
  }
}
```

### Option 3: Manual `claude_desktop_config.json` (global)

Add to your Claude Desktop config file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "strata": {
      "command": "npx",
      "args": ["strata-mcp"],
      "env": {}
    }
  }
}
```

### Verify

After restarting Claude Code, ask it to search your history:

```
You: "Search my past conversations for Docker configuration"
```

Claude Code will call the `search_history` tool automatically. If Strata is working, you will see results from your indexed conversation history.

You can also verify from the command line:

```bash
strata status
```

```
Strata v1.0.0
Database: /home/you/.strata/strata.db
Sessions: 142
Documents: 3847 chunks
Projects: 12
```

---

## Available Tools

Once connected, Claude Code has access to 8 community tools. It calls them automatically based on your requests.

### Search and Discovery

| Tool | What It Does |
|------|-------------|
| `search_history` | Full-text search across all past conversations. Supports inline filters: `project:name`, `before:7d`, `after:30d`, `tool:Bash`. BM25 ranking with recency and project boosts. |
| `find_solutions` | Search for past solutions to errors and problems. Results containing fix/resolve language score 1.5x higher. |
| `list_projects` | List all indexed projects with session counts, message counts, and date ranges. |
| `get_session_summary` | Get a structured summary of a specific session by ID or most recent for a project. |
| `get_project_context` | Comprehensive project context: recent sessions, key decisions, patterns. Useful at session start. |
| `find_patterns` | Discover recurring topics, workflow patterns, and repeated issues across sessions. |

### Memory Management

| Tool | What It Does |
|------|-------------|
| `store_memory` | Explicitly store a memory for future recall. Supports 9 types: decision, solution, error_fix, pattern, learning, procedure, fact, preference, episodic. Immediately searchable. |
| `delete_memory` | Hard-delete a memory entry by ID. The deletion is recorded in the audit trail. |

### Pro Tools (11 additional, requires license)

| Tool | What It Does |
|------|-------------|
| `semantic_search` | Hybrid FTS5 + vector cosine similarity search via Reciprocal Rank Fusion. Finds semantically similar content beyond keyword matching. |
| `find_procedures` | Search for stored step-by-step procedures and workflows. |
| `store_procedure` | Store a step-by-step procedure. Repeated stores of the same title merge steps automatically. |
| `search_entities` | Query the cross-session entity graph (libraries, services, tools, frameworks). |
| `update_memory` | Partially update an existing memory entry. Changes are recorded in the audit trail. |
| `memory_history` | View the mutation history (add/update/delete) for any memory entry. |
| `ingest_conversation` | Push conversations from external agents (Cursor, Slack bots, custom agents) into the extraction pipeline. |
| `cloud_sync_status/push/pull` | Cross-machine sync via encrypted cloud backend. |
| `get_analytics` | Local usage analytics: search patterns, tool usage, activity trends. |
| `list_evidence_gaps` | List topics searched but not found -- shows blind spots in your knowledge base. |

---

## Example Workflows

### Session Start: Load Context

At the beginning of a session, ask Claude Code to load your project context:

```
You: "What have we been working on in this project?"
```

Claude Code calls `get_project_context` and receives recent session summaries, key decisions, and patterns.

### Debugging: Find Past Solutions

When you hit an error, Claude Code can search for past solutions:

```
You: "I'm getting ECONNREFUSED on port 5432"
```

Claude Code calls `find_solutions({ error_or_problem: "ECONNREFUSED 127.0.0.1:5432", technology: "postgres" })` and retrieves past fixes.

### Store a Decision

After making an important decision, store it for future sessions:

```
You: "Remember that we decided to use bcrypt with cost factor 12 instead of argon2"
```

Claude Code calls `store_memory({ memory: "Use bcrypt with cost factor 12 for password hashing -- argon2 had deployment issues on Alpine", type: "decision", tags: ["security", "bcrypt"] })`.

### Search Past Work

Search across all your past conversations:

```
You: "How did we set up the CI pipeline for this project?"
```

Claude Code calls `search_history({ query: "CI pipeline setup", project: "current-project" })` and returns relevant conversation excerpts.

---

## Hooks and Skills Integration

For deeper integration, run `strata init` in your project directory:

```bash
cd /path/to/your/project
npx strata-mcp init
```

This installs:

- **Hooks** in `~/.claude/settings.json` -- automatically inject context at session start, extract knowledge at session end
- **Skills** in `.claude/skills/` -- slash commands for quick access
- **CLAUDE.md section** -- teaches Claude Code to use Strata tools proactively

### Available Slash Commands

| Command | What It Does |
|---------|-------------|
| `/recall <query>` | Multi-step search: broad search, solution check, refine, context, synthesize |
| `/remember <text>` | Store a memory with auto-detected type and extracted tags |
| `/gaps` | Show open evidence gaps -- things searched for but never answered |
| `/strata-status` | Quick project overview: context, patterns, and knowledge health |

---

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `STRATA_DATA_DIR` | Data directory (database location) | `~/.strata/` |
| `STRATA_LICENSE_KEY` | Pro/Team license key | _(free tier)_ |
| `STRATA_DEFAULT_USER` | Default user scope for multi-user setups | `default` |
| `STRATA_EXTRA_WATCH_DIRS` | Additional directories to watch (comma-separated) | _(none)_ |

### Pro Configuration (optional)

| Variable | Description |
|----------|-------------|
| `STRATA_EMBEDDING_PROVIDER` | Embedding provider: `local` (default), `openai`, or auto-detected Gemini |
| `GEMINI_API_KEY` | Gemini API key for embedding generation |
| `STRATA_OPENAI_API_KEY` | OpenAI API key (if using OpenAI embeddings) |
| `STRATA_API_URL` | Cloud sync server URL |
| `STRATA_API_KEY` | Cloud sync API key |
| `STRATA_TEAM_ID` | Team ID for shared sync |

Pass environment variables in the MCP configuration:

```json
{
  "mcpServers": {
    "strata": {
      "command": "npx",
      "args": ["strata-mcp"],
      "env": {
        "STRATA_LICENSE_KEY": "your-license-key",
        "GEMINI_API_KEY": "your-gemini-key"
      }
    }
  }
}
```

---

## Troubleshooting

**Strata is not responding to queries:**
1. Check that the MCP server is registered: look for "strata" in your MCP configuration
2. Restart Claude Code after adding the configuration
3. Run `strata status` to verify the database exists and has indexed data

**No results returned:**
1. Strata builds its index on first use. The first query may take a few seconds.
2. Run `strata status` to check how many sessions and documents are indexed
3. Try broader search terms or use `list_projects` to see available projects

**Index seems empty:**
1. Verify your AI tool's conversation files exist (e.g., `~/.claude/projects/`)
2. Run `strata status` to check which parsers are detected
3. Strata only indexes completed sessions; active sessions are skipped
