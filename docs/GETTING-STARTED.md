# Getting Started with Strata

This guide walks you through installing Strata, connecting it to your AI coding assistant, building your first index, and setting up hooks and skills for automatic context injection.

---

## Prerequisites

- **Node.js 18 or later** -- check with `node --version`
- **An AI coding assistant** with MCP support -- Claude Code, Codex CLI, Aider, Cline, or Gemini CLI
- **Existing conversation history** -- Strata indexes past conversations, so you need at least one previous session

---

## Step 1: Install Strata

Install globally via npm:

```bash
npm install -g strata-mcp
```

Verify the installation:

```bash
strata --version
```

Expected output:

```
1.0.0
```

The package provides two binary aliases: `strata` and `strata-mcp`. They are identical.

---

## Step 2: Register as an MCP Server

### Claude Code (recommended)

```bash
claude mcp add strata -- npx strata-mcp
```

This registers Strata in Claude Code's MCP server configuration. The `npx` wrapper ensures the latest version is always used.

Verify registration:

```bash
claude mcp list
```

Expected output:

```
strata: npx strata-mcp
```

### Manual configuration (any MCP client)

If your MCP client uses a JSON config file, add this entry:

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

For Claude Code, this file is `~/.claude/settings.json` under the `mcpServers` key.

### HTTP transport (non-stdio clients)

If your client does not support stdio, start Strata as an HTTP server:

```bash
strata serve --port 3000
```

Then point your MCP client to `http://localhost:3000/mcp`.

---

## Step 3: First Run -- Verify with `strata status`

Run the status command to confirm Strata can find your data:

```bash
strata status
```

Expected output (first run, before indexing):

```
Strata v1.0.0
Database: /home/you/.strata/strata.db
Sessions: 0
Documents: 0 chunks
Projects: 0
Parsers: claude-code (detected), codex (not found), aider (not found), cline (not found), gemini-cli (not found)
```

The `Parsers` line shows which AI tools Strata found on your machine. If your tool shows `(detected)`, Strata knows where to find its conversation files and will index them automatically.

**If no parsers are detected:** Strata looks for conversation history in default locations (e.g., `~/.claude/projects/` for Claude Code). If your data is in a non-standard location, set `STRATA_EXTRA_WATCH_DIRS`:

```bash
export STRATA_EXTRA_WATCH_DIRS="/path/to/custom/history"
```

---

## Step 4: Build the Index

Strata builds the index lazily on first search. Run a test search to trigger the build:

```bash
strata search "test"
```

On first run, Strata will:
1. Scan all detected conversation history directories
2. Parse conversation files into messages
3. Chunk messages and insert them into the SQLite FTS5 index
4. Extract knowledge entries (decisions, solutions, error fixes, patterns)
5. Generate session summaries

This typically takes 5-30 seconds depending on how much history you have. Subsequent runs use incremental updates and complete in under a second.

Expected output after indexing:

```
  Found 12 results across 8 sessions (0.14s)

  +-- Session 2026-03-10 -------------------------------------------+
  |   Wrote unit tests for the authentication middleware using       |
  |   vitest and mock JWT tokens...                                 |
  |   Score: 4.21  |  Project: api-gateway                          |
  +----------------------------------------------------------------+

  +-- Session 2026-03-08 -------------------------------------------+
  |   Added integration tests for the database migration scripts... |
  |   Score: 3.87  |  Project: data-pipeline                        |
  +----------------------------------------------------------------+
```

If you see `No results found.`, your conversation history may be empty or in a non-standard location. Check `strata status` to verify which parsers are detected.

### Verify the index

Run `strata status` again to see the indexed data:

```
Strata v1.0.0
Database: /home/you/.strata/strata.db
Sessions: 142
Documents: 3847 chunks
Projects: 12
Parsers: claude-code (detected), codex (detected), aider (not found), cline (not found), gemini-cli (not found)
```

---

## Step 5: Try It in Your AI Assistant

Start a new Claude Code session and try these prompts:

**Search past work:**
> Search my history for how we set up the CI pipeline

Claude will call `search_history` and return ranked results from your past sessions.

**Find solutions to errors:**
> I'm getting "ECONNREFUSED on port 5432" -- have I fixed this before?

Claude will call `find_solutions` with solution-biased ranking.

**Store a decision:**
> Remember that we chose PostgreSQL over MySQL for JSONB support

Claude will call `store_memory` with type `decision`.

**Get project context:**
> What have I been working on in this project lately?

Claude will call `get_project_context` for a structured overview.

---

## Step 6: Set Up Hooks for Automatic Context Injection

Hooks make Strata proactive. Instead of waiting for you to ask, Strata automatically injects relevant context at the start of every session and saves knowledge when sessions end.

Run the init command in your project directory:

```bash
cd /path/to/your/project
npx strata-mcp init
```

Expected output:

```
Strata -- Project Setup

1. Installing skills...
   Copied recall.md
   Copied remember.md
   Copied gaps.md
   Copied strata-status.md
   4 skill(s) installed to .claude/skills/

2. Registering hooks...
   Registered SessionStart hook.
   Registered Stop hook.
   Registered SubagentStart hook.

3. Updating CLAUDE.md...
   Appended Strata Memory section to CLAUDE.md.

4. Ensuring data directory...
   ~/.strata/ ready.

--- Setup Complete ---

Verify your setup:
  1. Start a new Claude Code session in this project
  2. You should see '[Strata] Previous context for...' on startup
  3. Try /recall, /remember, /gaps, or /strata-status

If the MCP server isn't configured yet:
  claude mcp add strata -- npx strata-mcp
```

### What the hooks do

**SessionStart** -- runs when you open a new Claude Code session. Outputs context like:

```
[Strata] Previous context for api-gateway:
- Last session (today): Refactored auth middleware to use JWT validation
- Last session (2 days ago): Fixed CORS preflight handling for OPTIONS
- Key decision: Use bcrypt with cost factor 12 for password hashing
- Solution found: PostgreSQL ECONNREFUSED fix -- systemctl enable postgresql
- Learning: Always run migrations before seeding in CI

[Strata] Available memory tools:
- Hit an error? -> find_solutions "error message" to check past fixes
- Making a decision? -> store_memory "text" type=decision to remember it
- Need project context? -> get_project_context project="name"
- Searching past work? -> search_history "query" for full-text search

[Strata] Knowledge gaps (searched but never answered):
- "kubernetes deployment" (searched 5 times)
- "CORS middleware config" (searched 3 times)
If you learn about these topics, use store_memory to fill the gap.
```

**Stop** -- runs when a session ends. Extracts knowledge from the conversation (decisions, solutions, fixes) and saves session summaries to the database.

**SubagentStart** -- runs when a Claude Code subagent (teammate) is spawned. Injects a compact version of project context and available tools.

---

## Step 7: Set Up Skills for Slash Commands

The `strata init` command (Step 6) already copied skill files to `.claude/skills/`. These enable slash commands in Claude Code:

| Command | What It Does |
|---------|-------------|
| `/recall <query>` | Multi-step search: broad search, solution check, refine, context, synthesize. More thorough than a raw `search_history` call. |
| `/remember <text>` | Store a memory with auto-detected type (decision, error_fix, solution, etc.) and extracted tags. |
| `/gaps` | Show evidence gaps -- topics you have searched for but never found answers to. |
| `/strata-status` | Quick project overview: recent sessions, key decisions, patterns, knowledge health. |

### Try them

Start a new Claude Code session in your project and type:

```
/strata-status
```

This runs `get_project_context`, `list_projects`, and `find_patterns` in parallel and returns a structured overview.

```
/recall authentication middleware
```

This performs a multi-step search: broad search, solution check, refinement, and synthesis with session citations.

```
/remember We decided to use Redis for session storage because Memcached doesn't support persistence
```

This auto-detects the type as `decision`, extracts tags `[redis, memcached, session-storage]`, and calls `store_memory`.

If skills are not appearing as slash commands, verify the files exist:

```bash
ls .claude/skills/
# Expected: gaps.md  recall.md  remember.md  strata-status.md
```

Skills are loaded at session start, so restart Claude Code after adding new skill files.

---

## Step 8: Store Your First Memory

You can store memories through your AI assistant or directly from the CLI.

### Via CLI

```bash
strata store-memory "Always run database migrations before seed scripts in CI" --type decision --tags "ci,database,migrations"
```

Expected output:

```
  Stored decision: "Always run database migrations before seed scripts in CI"
```

### Via your assistant

Tell Claude:

> Remember that the API rate limit is 100 requests per minute per API key

Claude will call `store_memory` with type `fact` and relevant tags.

### Via slash command

```
/remember The fix for the flaky test was adding a 100ms delay after database writes -- eventual consistency issue
```

The `/remember` skill auto-detects this as an `error_fix` and stores it with appropriate tags.

---

## Next Steps

### Explore your knowledge base

```bash
# List all indexed projects
strata search "test" --project my-api

# Search with JSON output for scripting
strata search "authentication" --json --limit 5
```

### Read the full documentation

| Document | Description |
|----------|-------------|
| [README](../README.md) | Feature overview and quick reference |
| [Architecture](ARCHITECTURE.md) | System design, data flow, and module overview |
| [Tools Reference](TOOLS.md) | Complete MCP tool API with all parameters |
| [Hooks and Skills](HOOKS-AND-SKILLS.md) | Detailed hook setup, skill definitions, agent integration |

### Upgrade to Pro

If you need semantic (vector) search, cloud sync, procedure storage, entity graphs, or analytics:

```bash
strata activate STRATA-XXXX-XXXX-XXXX
```

Visit [strata.kytheros.dev/pricing](https://strata.kytheros.dev/pricing) for plans.

---

## Troubleshooting

### "No results found" on first search

The index may be empty. Check:

```bash
strata status
```

If `Documents: 0 chunks`, Strata hasn't found any conversation history. Verify:
- You have past sessions in your AI tool (check `~/.claude/projects/` for Claude Code)
- The correct parser is `(detected)` in `strata status` output
- If using a non-standard location, set `STRATA_EXTRA_WATCH_DIRS`

### No context injected at session start

The SessionStart hook could not find data for your current project. Causes:
- The index is empty -- run `strata search "test"` to trigger a build
- Hooks are not registered -- run `npx strata-mcp init` or check `~/.claude/settings.json`
- Wrong project directory -- hooks use `process.cwd()` to identify the project

### MCP server not connecting

```bash
# Verify registration
claude mcp list

# If not listed, add it
claude mcp add strata -- npx strata-mcp

# If listed but not working, check that npx can find the package
npx strata-mcp --version
```

### Skills not appearing as slash commands

- Verify files exist in `.claude/skills/` relative to your project root
- Restart Claude Code (skills are loaded at session start)
- Check file names: `recall.md`, `remember.md`, `gaps.md`, `strata-status.md`

### Database location

By default, Strata stores everything at `~/.strata/strata.db`. To use a different location:

```bash
export STRATA_DATA_DIR="/path/to/custom/dir"
```

The database file will be created at `$STRATA_DATA_DIR/strata.db`.
