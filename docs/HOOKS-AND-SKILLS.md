# Hooks, Skills, and Agent Integration

This guide covers how to set up Strata's Claude Code integration layer — the hooks, skills, and agent definitions that make Strata proactively useful in your projects.

## Overview

Strata works at three levels within Claude Code:

| Layer | What it does | Setup |
|-------|-------------|-------|
| **MCP Server** | Exposes memory tools (`search_history`, `store_memory`, etc.) | `claude mcp add` |
| **Hooks** | Auto-inject context at session start, save on session end | `settings.json` |
| **Skills** | Slash commands (`/recall`, `/remember`) with multi-step workflows | `.claude/skills/` |
| **Agent integration** | Agents proactively search/store via skills and tools | `.claude/agents/` + `CLAUDE.md` |

## Quick Setup

The fastest way to get everything configured:

```bash
cd /path/to/your/project
npx strata-mcp init
```

This command:
1. Copies skill files to `.claude/skills/`
2. Registers hooks in `~/.claude/settings.json`
3. Appends a Strata Memory section to `CLAUDE.md`
4. Creates `~/.strata/` data directory

To overwrite existing configuration: `npx strata-mcp init --force`

## Manual Setup

### 1. MCP Server

Register Strata as an MCP server so Claude Code can access its tools:

```bash
claude mcp add strata -- npx strata-mcp
```

Verify with: `claude mcp list`

### 2. Hooks

Hooks run automatically at key Claude Code lifecycle events. Add them to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/strata-mcp/dist/hooks/session-start-hook.js\""
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/strata-mcp/dist/hooks/session-stop-hook.js\""
          }
        ]
      }
    ],
    "SubagentStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/strata-mcp/dist/hooks/subagent-start-hook.js\""
          }
        ]
      }
    ]
  }
}
```

Replace `/path/to/strata-mcp/` with the actual installed path. To find it:

```bash
npm list -g strata-mcp --parseable
```

#### What Each Hook Does

**SessionStart** — Injects context when a new Claude Code session begins:
- Last 3 session summaries for the current project
- Key decisions and solutions from the knowledge store
- Recurring issues and synthesized learnings
- Tool guidance (reminds the model to use Strata tools)
- Knowledge gaps (topics searched 2+ times with no results)

**Stop** — Triggers when a session ends:
- Saves session summary to the database
- Synthesizes learnings from the conversation
- Updates the knowledge store with new entries

**SubagentStart** — Injects context when a subagent (teammate) is spawned:
- Compact version of session context
- List of available Strata tools
- Proactive usage rules (search before solving, store after fixing)

### 3. Skills

Skills are markdown files in `.claude/skills/` that define slash commands. Copy them from the Strata templates:

```bash
# If installed globally
cp -r $(npm root -g)/strata-mcp/templates/skills/*.md .claude/skills/

# Or from a local install
cp -r node_modules/strata-mcp/templates/skills/*.md .claude/skills/
```

#### Available Skills

| Skill | Command | Description |
|-------|---------|-------------|
| **Recall** | `/recall <query>` | Multi-step search: broad search → solution check → refine → context → synthesize |
| **Remember** | `/remember <text>` | Store a memory with auto-detected type (decision, error_fix, solution, etc.) and extracted tags |
| **Gaps** | `/gaps` | Show open evidence gaps — things searched for but never answered |
| **Strata Status** | `/strata-status` | Quick overview: project context + all projects + pattern analysis in parallel |

#### How Skills Work

When a user types `/recall authentication middleware`, Claude Code:
1. Reads `.claude/skills/recall.md` for instructions
2. Follows the multi-step process defined there
3. Calls `search_history`, `find_solutions`, and `get_session_summary` MCP tools
4. Synthesizes results into a concise answer with citations

Skills are more powerful than raw tool calls because they chain multiple tools with intelligent decision-making between steps.

### 4. Agent Integration

If your project uses Claude Code agent teams, each agent definition should include a Strata integration section.

#### For read-write agents (developers)

Add this section to your agent `.md` file:

```markdown
## Strata Integration

You have access to Strata memory skills and MCP tools. Use them proactively:
- **Before debugging:** `/recall` with the error message to search past fixes
- **After decisions or fixes:** `/remember` to store it (auto-detects type and tags)
- **When starting work:** `/strata-status` for project context overview
- **When searching past work:** `/recall` with relevant keywords
- **To check knowledge gaps:** `/gaps` to see what's been searched but never answered

For direct MCP tool access: `find_solutions`, `search_history`, `store_memory`,
`get_project_context`, `find_patterns`, `list_projects`
```

#### For read-only agents (security, research)

```markdown
## Strata Integration

You have access to Strata memory skills and MCP tools for research:
- **Before researching:** `/recall` with the topic to search past discussions
- **Understanding project state:** `/strata-status` for project context overview
- **Checking recurring patterns:** `find_patterns` type=all for workflow and topic analysis
- **After discovering insights:** `/remember` to store findings for future reference
- **Checking knowledge gaps:** `/gaps` to see what topics need coverage
```

These templates are also available at:
- `templates/agent-integration-readwrite.md`
- `templates/agent-integration-readonly.md`

### 5. CLAUDE.md

Add a Strata Memory section to your project's `CLAUDE.md` so every session sees it:

```markdown
## Strata Memory

This project uses Strata MCP tools for persistent memory across sessions. When available:
- Search for prior solutions before debugging: `/recall` or `find_solutions`
- Store important decisions and fixes: `/remember` or `store_memory`
- Check project context at session start: `/strata-status` or `get_project_context`
- View knowledge gaps: `/gaps`

### When to Store Memories
- After making architectural decisions
- After fixing non-obvious bugs
- After discovering project-specific patterns
- When learning something that will be useful in future sessions
```

## Starter Template

For new projects, use the pre-configured starter template:

```bash
cp -r $(npm root -g)/strata-mcp/templates/strata-starter/.claude /path/to/project/
cp $(npm root -g)/strata-mcp/templates/strata-starter/CLAUDE.md /path/to/project/
```

The starter template includes:
- All 4 skills pre-configured
- A sample agent definition with Strata integration
- A CLAUDE.md with the Strata Memory section
- A README explaining the setup

## Verification

After setup, verify everything works:

1. **Start a new Claude Code session** in your project directory
2. **Check for context injection** — you should see `[Strata] Previous context for...`
3. **Test skills** — try `/recall`, `/remember`, `/gaps`, `/strata-status`
4. **Test tools** — try `search_history "test query"` directly

If context isn't injected:
- Verify hooks are in `~/.claude/settings.json`
- Check that the hook file paths resolve correctly
- Run `strata status` to check if the index has data

If skills don't appear:
- Verify `.claude/skills/` contains the `.md` files
- Check that you're in the right project directory
- Restart Claude Code (skills are loaded at session start)

## Troubleshooting

### "No context injected at session start"

The SessionStart hook found no data for your project. Build the index first:

```bash
strata search "test"  # This triggers an auto-build if the index is empty
```

Or build explicitly:

```bash
npm run build-index   # If running from the strata source
```

### "Skills not showing in slash commands"

Skills must be in the `.claude/skills/` directory relative to your project root. Verify:

```bash
ls .claude/skills/
# Should show: recall.md  remember.md  gaps.md  strata-status.md
```

### "Hook command not found"

The hook path in `settings.json` must point to the compiled JavaScript file. If you installed globally:

```bash
# Find the global install path
npm root -g
# Hooks are at: <global-root>/strata-mcp/dist/hooks/
```

### "MCP server not connecting"

Verify the MCP server is registered:

```bash
claude mcp list
# Should show: strata -- npx strata-mcp
```

If not listed, add it:

```bash
claude mcp add strata -- npx strata-mcp
```
