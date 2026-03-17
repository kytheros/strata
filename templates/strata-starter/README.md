# Strata Starter Template

This is a pre-configured project template for [Strata](https://strata.kytheros.dev), the local memory layer for AI coding assistants.

## What's Included

### Skills (`.claude/skills/`)
Slash commands that wrap Strata MCP tools with multi-step workflows:
- `/recall <query>` — Multi-step search across your conversation history
- `/remember <text>` — Store a memory with auto-detected type and tags
- `/gaps` — View open evidence gaps (things searched but never answered)
- `/strata-status` — Get a quick overview of project context

### Agent Definition (`.claude/agents/dev.md`)
A sample agent definition with Strata integration. Agents spawned from this definition will proactively use Strata skills to search past work and store new knowledge.

### CLAUDE.md
Project-level instructions with a Strata Memory section. Every Claude Code session in this project will see guidance for using Strata tools.

## Setup

1. **Install Strata** (if not already installed):
   ```bash
   npm install -g strata-mcp
   ```

2. **Copy this template** to your project root:
   ```bash
   cp -r strata-starter/.claude /path/to/your/project/
   cp strata-starter/CLAUDE.md /path/to/your/project/
   ```
   Or use the automated setup:
   ```bash
   cd /path/to/your/project
   npx strata-mcp init
   ```

3. **Configure hooks** in `~/.claude/settings.json`:
   ```json
   {
     "hooks": {
       "SessionStart": [{ "command": "npx strata-mcp hook session-start" }],
       "Stop": [{ "command": "npx strata-mcp hook session-stop" }],
       "SubagentStart": [{ "command": "npx strata-mcp hook subagent-start" }]
     }
   }
   ```

4. **Customize** `CLAUDE.md` with your project name and description.

5. **Verify** by starting a new Claude Code session — you should see `[Strata] Previous context for...` output.

## Customizing

- **Add more agents:** Create additional `.md` files in `.claude/agents/` with the `## Strata Integration` section
- **Edit CLAUDE.md:** Add project-specific instructions alongside the Strata Memory section
- **Update skills:** Skills are markdown files — edit them to customize the search/store workflows
