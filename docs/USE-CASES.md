# Use Cases

Strata serves three distinct usage modes. Each mode uses the same core engine but differs in transport, data flow, and primary audience. This document explains all three modes with concrete examples and integration patterns.

---

## Mode A: Personal Dev Tool

**The primary use case.** Strata runs as a local MCP server inside your AI coding assistant, auto-indexes your conversations, and gives you searchable memory across sessions.

### How It Works

1. You install Strata as an MCP server in Claude Code, Codex CLI, Aider, Cline, or Gemini CLI.
2. Strata's file watcher monitors conversation directories (e.g., `~/.claude/projects/`) and indexes new sessions into a local SQLite/FTS5 database.
3. During a coding session, your AI assistant can call Strata's MCP tools to search past work, find prior solutions, store decisions, and retrieve project context.

### Transport

**stdio** -- Strata runs as a child process of the AI tool, communicating over stdin/stdout via the MCP protocol. No network, no ports, no auth.

### Setup

Add Strata to your MCP configuration. For Claude Code:
```bash
claude mcp add strata -- npx strata-mcp
```

For other tools, point their MCP client configuration at the `strata-mcp` binary or `npx strata-mcp` command.

### Available Tools

| Tool | Purpose |
|------|---------|
| `search_history` | Full-text search across all past conversations |
| `find_solutions` | Find past solutions to errors (solution-biased ranking) |
| `list_projects` | Discover which projects have searchable history |
| `get_session_summary` | Get a structured summary of a specific session |
| `get_project_context` | Get recent sessions, decisions, and patterns for a project |
| `find_patterns` | Discover recurring topics, workflow trends, and repeated issues |
| `store_memory` | Explicitly store a decision, solution, or learning |
| `delete_memory` | Remove a stale or incorrect memory entry |

### Example Workflow

You are debugging a React hydration error. You remember fixing something similar three weeks ago but cannot recall the details.

**Step 1:** Your AI assistant calls `find_solutions`:
```
find_solutions({ error_or_problem: "React hydration mismatch", technology: "react" })
```

**Step 2:** Strata returns a ranked list of past conversations where hydration errors were discussed, with solution-biased ranking (results containing fix/resolution language score 1.5x higher).

**Step 3:** The assistant reads the prior solution and applies it -- or adapts it -- to the current problem.

**Step 4:** After resolving the issue, the assistant stores the new fix:
```
store_memory({
  memory: "React hydration mismatch caused by date formatting in SSR. Fix: use useEffect for client-only date rendering instead of inline Date.now().",
  type: "error_fix",
  tags: ["react", "hydration", "ssr"],
  project: "myapp"
})
```

This memory is immediately searchable in future sessions.

---

## Mode B: Agentic Memory Layer

**For AI agent frameworks.** Strata runs as an HTTP server that agents connect to over the network. Agents store and retrieve memories programmatically, providing persistent memory across runs.

### How It Works

1. You start Strata's HTTP server: `strata serve --port 3000`.
2. AI agents (LangChain, CrewAI, AutoGen, custom frameworks) connect to `http://localhost:3000/mcp` using an MCP client.
3. Agents call `store_memory` to persist findings and `search_history` / `find_solutions` to retrieve them in later runs.

### Transport

**HTTP with Streamable HTTP transport** -- Strata listens on a configurable port and exposes the MCP protocol over HTTP. Sessions are managed via the `mcp-session-id` header.

**Routes:**
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/mcp` | MCP JSON-RPC requests (initialize or tool calls) |
| GET | `/mcp` | SSE stream for an existing session |
| DELETE | `/mcp` | Session termination |
| GET | `/health` | Health check |

### Use Case: Persistent Agent Memory

Consider a multi-agent system where a research agent gathers information and a coding agent implements solutions. Without Strata, findings are lost between runs. With Strata, the research agent stores its findings and the coding agent retrieves them in a later run.

**Run 1 -- Research agent stores findings:**
```
store_memory({
  memory: "The Stripe API v2024-12-18 changed webhook signature verification. Must use stripe.webhooks.constructEventAsync() instead of constructEvent(). The sync version is deprecated and will be removed in Q2 2025.",
  type: "fact",
  tags: ["stripe", "webhooks", "api-change"],
  project: "payments-service"
})
```

**Run 2 -- Coding agent retrieves findings:**
```
search_history({ query: "stripe webhook signature verification", project: "payments-service" })
```

The coding agent gets the research agent's findings without re-doing the research.

### Python Integration Example

Using the MCP client SDK to connect a LangChain/CrewAI agent to Strata over HTTP:

```python
import asyncio
import json
import httpx

STRATA_URL = "http://localhost:3000/mcp"

async def mcp_initialize(client: httpx.AsyncClient) -> str:
    """Initialize an MCP session and return the session ID."""
    resp = await client.post(STRATA_URL, json={
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "my-agent", "version": "1.0.0"}
        }
    })
    session_id = resp.headers.get("mcp-session-id")
    return session_id

async def mcp_call_tool(
    client: httpx.AsyncClient,
    session_id: str,
    tool_name: str,
    arguments: dict,
    request_id: int = 2
) -> dict:
    """Call an MCP tool and return the result."""
    resp = await client.post(
        STRATA_URL,
        headers={"mcp-session-id": session_id},
        json={
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": arguments}
        }
    )
    return resp.json()

async def main():
    async with httpx.AsyncClient() as client:
        session_id = await mcp_initialize(client)

        # Store a memory
        await mcp_call_tool(client, session_id, "store_memory", {
            "memory": "Redis cluster needs at least 3 master nodes for production.",
            "type": "fact",
            "tags": ["redis", "infrastructure"],
            "project": "platform"
        })

        # Search for past solutions
        result = await mcp_call_tool(client, session_id, "find_solutions", {
            "error_or_problem": "Redis CLUSTERDOWN",
            "technology": "redis"
        })
        print(json.dumps(result, indent=2))

asyncio.run(main())
```

### Node.js Integration Example

Using the official `@modelcontextprotocol/sdk` to connect from a Node.js agent:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function main() {
  const transport = new StreamableHTTPClientTransport(
    new URL("http://localhost:3000/mcp")
  );

  const client = new Client(
    { name: "my-agent", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);

  // Store a memory
  const storeResult = await client.callTool({
    name: "store_memory",
    arguments: {
      memory: "Always use connection pooling with pg. Default pool size of 10 is fine for dev but set to 50 for production.",
      type: "decision",
      tags: ["postgres", "connection-pooling"],
      project: "api-server"
    }
  });
  console.log("Stored:", storeResult);

  // Search history
  const searchResult = await client.callTool({
    name: "search_history",
    arguments: {
      query: "postgres connection pool configuration",
      project: "api-server"
    }
  });
  console.log("Search results:", searchResult);

  await client.close();
}

main();
```

---

## Mode C: Agent Development Platform

**For Claude Code agent teams.** Strata serves as a shared memory layer for coordinated multi-agent workflows, where a human team lead and multiple spawned agents collaborate on the same codebase.

### How It Works

1. Run `strata init` in your project to install skills (`/recall`, `/remember`, `/gaps`, `/strata-status`) and hooks (`session-start`, `session-stop`, `subagent-start`) into the project's `.claude/` directory.
2. The session-start hook auto-injects context from previous sessions when any agent starts working on the project.
3. Agents and the human lead use slash commands to interact with shared memory.
4. Evidence gap tracking identifies topics that have been searched but never answered -- knowledge the team does not yet have.

### Transport

**stdio** -- Each agent runs Strata as a local MCP server, same as the personal dev tool mode. The shared state comes from the SQLite database on disk, which all agents read from and write to.

### Skills

Skills are slash commands registered in `.claude/skills/`:

| Skill | Purpose |
|-------|---------|
| `/recall` | Search memory for context relevant to the current task |
| `/remember` | Store a decision, fix, or learning into persistent memory |
| `/gaps` | List open evidence gaps -- things the team searched for but has no answer to |
| `/strata-status` | Show index statistics, detected parsers, and database health |

### Hooks

Hooks are registered in `.claude/settings.json` and run automatically:

| Hook | Trigger | Purpose |
|------|---------|---------|
| `session-start` | New session begins | Injects previous context: last 3 session summaries, key decisions, solutions, error fixes, learnings, recurring issues, and open knowledge gaps |
| `session-stop` | Session ends | Indexes the completed session and synthesizes learnings |
| `subagent-start` | Spawned agent begins | Provides the subagent with project-specific context from the shared memory |

### Context Injection

When a session starts, the session-start hook reads from the SQLite database and outputs a context block to stdout. This block includes:

- **Session summaries** -- topics from the last 3 sessions with relative timestamps
- **Key decisions** -- up to 2 recent decisions stored via `store_memory`
- **Solutions** -- up to 2 recently discovered solutions
- **Error fixes** -- the most recent error fix
- **Learnings** -- up to 3 synthesized cross-session learnings
- **Recurring issues** -- the most frequent recurring problem
- **Knowledge gaps** -- topics searched 2+ times but never answered

Example hook output:
```
[Strata] Previous context for myapp:
- Last session (today): Fixed auth middleware to handle expired JWT refresh tokens
- Last session (2 days ago): Added rate limiting to API endpoints using express-rate-limit
- Key decision: Use Redis for session storage instead of in-memory store
- Solution found: CORS preflight fails when Access-Control-Allow-Headers is missing Content-Type
- Learning: Always set explicit timeouts on HTTP clients to prevent hanging requests

[Strata] Available memory tools:
- Hit an error? -> find_solutions "error message" to check past fixes
- Making a decision? -> store_memory "text" type=decision to remember it
- Need project context? -> get_project_context project="name"
- Searching past work? -> search_history "query" for full-text search

[Strata] Knowledge gaps (searched but never answered):
- "websocket reconnection strategy" (searched 3 times)
- "database sharding approach" (searched 2 times)
If you learn about these topics, use store_memory to fill the gap.
```

### Example: Coordinated Agent Team

A team lead spawns three agents to work on a large feature. Each agent benefits from shared memory.

**Team lead spawns agents:**
1. **Agent A** (core-engine) -- refactors the database layer
2. **Agent B** (pro-features) -- adds a new API endpoint
3. **Agent C** (frontend) -- builds the UI component

**What happens automatically:**
- Each agent's session-start hook fires, injecting context about recent work on the project.
- Agent A discovers a schema migration issue. It uses `/remember` to store the fix:
  ```
  /remember "PostgreSQL ENUM types cannot have values removed in a migration. To rename: add new value, update rows, remove old value in separate migration."
  ```
- Agent B, working on the API endpoint, hits a related database issue. Its next search via `/recall` surfaces Agent A's stored memory -- even though Agent A stored it moments ago.
- Agent C uses `/gaps` to see what the team does not know yet, and proactively investigates those topics.

**After the session:**
- The session-stop hook indexes all three agents' conversations.
- Learnings are synthesized across sessions.
- The next time anyone works on this project, the session-start hook surfaces all of this context automatically.

---

## Comparison Table

| Aspect | Personal Dev Tool | Agentic Memory Layer | Agent Development Platform |
|--------|-------------------|----------------------|---------------------------|
| **Transport** | stdio | HTTP (Streamable HTTP) | stdio |
| **Data source** | Auto-indexed conversations | Programmatic via API | Auto-indexed + skills/hooks |
| **Primary user** | Human developer | AI agent (LangChain, CrewAI, etc.) | Human lead + spawned agents |
| **Primary interface** | MCP tools in AI assistant | HTTP API calls | Slash commands + auto-hooks |
| **Setup** | `claude mcp add strata` | `strata serve --port 3000` | `strata init` in project |
| **Memory storage** | Automatic from conversations | Explicit via `store_memory` | Both automatic and explicit |
| **Context injection** | On-demand via tools | On-demand via API | Automatic via session hooks |
| **Multi-user** | Single user | Multiple agents | Team of agents + human |
| **Typical scale** | One developer's history | Hundreds of agent runs | 3-5 coordinated agents |
| **Key benefit** | "I fixed this before" recall | Persistent agent memory | Shared team knowledge |

---

## Choosing a Mode

**Start with Mode A** if you are an individual developer using AI coding assistants. This is the zero-configuration path -- install Strata as an MCP server and it works immediately.

**Use Mode B** if you are building AI agent systems that need persistent memory across runs. The HTTP transport makes Strata accessible to any framework that can make HTTP requests.

**Use Mode C** if you are running Claude Code agent teams and want agents to share context, avoid duplicate work, and build on each other's findings. Run `strata init` in your project to install the skills and hooks.

The modes are not mutually exclusive. You can run Strata as a personal dev tool (Mode A) and also start the HTTP server (Mode B) for agent integration simultaneously -- they share the same SQLite database.

---

## Related Documentation

- [TOOLS.md](./TOOLS.md) -- Full reference for all 8 MCP tools
- [MULTI-TOOL.md](./MULTI-TOOL.md) -- Supported AI coding tools and auto-detection
- [DEPLOYMENT.md](./DEPLOYMENT.md) -- Running Strata as stdio, HTTP, Docker, or Cloud Run
- [HOOKS-AND-SKILLS.md](./HOOKS-AND-SKILLS.md) -- Detailed hook and skill reference
