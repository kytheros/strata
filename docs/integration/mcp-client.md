# Integration: Generic MCP Client

Strata exposes its tools via the Model Context Protocol (MCP). Any MCP-compatible client can connect to Strata over stdio or HTTP transport.

---

## Transport Options

### stdio (default)

The standard transport for local MCP servers. The client spawns Strata as a child process and communicates over stdin/stdout.

```bash
# Start Strata on stdio
npx strata-mcp
# or, if installed globally:
strata
```

### HTTP (alternative)

For clients that cannot use stdio (remote servers, browser-based clients, multi-client setups), Strata can serve over HTTP with Streamable HTTP transport:

```bash
# Start HTTP server on port 3000 (default)
strata serve

# Custom port
strata serve --port 8080

# Or via PORT env var
PORT=8080 strata serve
```

**Endpoints:**

| Route | Method | Description |
|-------|--------|-------------|
| `/mcp` | POST | MCP JSON-RPC endpoint (Streamable HTTP transport) |
| `/health` | GET | Health check (returns 200 OK with server info) |

---

## TypeScript MCP SDK Example

Connect to Strata programmatically using the official MCP SDK:

### stdio Transport

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  // Spawn Strata as a child process
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["strata-mcp"],
  });

  const client = new Client(
    { name: "my-app", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);

  // List available tools
  const tools = await client.listTools();
  console.log("Available tools:", tools.tools.map(t => t.name));

  // Search conversation history
  const searchResult = await client.callTool({
    name: "search_history",
    arguments: {
      query: "docker compose networking",
      limit: 5,
    },
  });
  console.log("Search results:", searchResult.content);

  // Store a memory
  const storeResult = await client.callTool({
    name: "store_memory",
    arguments: {
      memory: "Always use bridge network for Docker Compose services",
      type: "decision",
      tags: ["docker", "networking"],
      project: "my-project",
    },
  });
  console.log("Store result:", storeResult.content);

  // Find solutions to an error
  const solutionResult = await client.callTool({
    name: "find_solutions",
    arguments: {
      error_or_problem: "ECONNREFUSED 127.0.0.1:5432",
      technology: "postgres",
    },
  });
  console.log("Solutions:", solutionResult.content);

  // Get project context
  const contextResult = await client.callTool({
    name: "get_project_context",
    arguments: {
      project: "my-project",
      depth: "normal",
    },
  });
  console.log("Context:", contextResult.content);

  await client.close();
}

main().catch(console.error);
```

### HTTP Transport

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function main() {
  // Connect to a running Strata HTTP server
  const transport = new StreamableHTTPClientTransport(
    new URL("http://localhost:3000/mcp")
  );

  const client = new Client(
    { name: "my-app", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);

  // Use the client exactly the same as with stdio
  const result = await client.callTool({
    name: "search_history",
    arguments: { query: "authentication setup" },
  });
  console.log(result.content);

  await client.close();
}

main().catch(console.error);
```

---

## Tool Reference

### Community Tools (8, always available)

#### search_history

Full-text search across past conversations with BM25 ranking.

```json
{
  "name": "search_history",
  "arguments": {
    "query": "docker compose project:api-gateway after:7d",
    "project": "optional-project-filter",
    "limit": 20,
    "include_context": false,
    "format": "standard",
    "user": "optional-user-scope",
    "max_chars": 2500
  }
}
```

Inline filter syntax in the query string:
- `project:name` -- filter by project
- `before:7d` / `after:30d` -- relative date filters
- `before:2024-01-15` -- absolute date filter
- `tool:Bash` -- filter by tool used

#### find_solutions

Search for past solutions to errors or problems. Results containing fix/resolution language score 1.5x higher.

```json
{
  "name": "find_solutions",
  "arguments": {
    "error_or_problem": "ECONNREFUSED 127.0.0.1:5432",
    "technology": "postgres",
    "format": "standard"
  }
}
```

#### list_projects

List all indexed projects with session counts and date ranges.

```json
{
  "name": "list_projects",
  "arguments": {
    "sort_by": "recent",
    "format": "standard"
  }
}
```

#### get_session_summary

Get a structured summary of a specific session.

```json
{
  "name": "get_session_summary",
  "arguments": {
    "session_id": "uuid-here",
    "project": "or-project-name-for-most-recent"
  }
}
```

#### get_project_context

Comprehensive project context with recent sessions, decisions, and patterns.

```json
{
  "name": "get_project_context",
  "arguments": {
    "project": "my-project",
    "depth": "normal"
  }
}
```

Depth options: `"brief"` (last session), `"normal"` (last 3), `"detailed"` (last 5 + topic analysis).

#### find_patterns

Discover recurring patterns in conversation history.

```json
{
  "name": "find_patterns",
  "arguments": {
    "project": "optional-project",
    "type": "all"
  }
}
```

Type options: `"topics"`, `"workflows"`, `"issues"`, `"all"`.

#### store_memory

Store a memory for future recall.

```json
{
  "name": "store_memory",
  "arguments": {
    "memory": "Use bcrypt with cost factor 12 for password hashing",
    "type": "decision",
    "tags": ["security", "bcrypt"],
    "project": "my-project",
    "user": "optional-user-scope"
  }
}
```

Type options: `"decision"`, `"solution"`, `"error_fix"`, `"pattern"`, `"learning"`, `"procedure"`, `"fact"`, `"preference"`, `"episodic"`.

#### delete_memory

Hard-delete a memory entry by ID.

```json
{
  "name": "delete_memory",
  "arguments": {
    "id": "entry-id-to-delete"
  }
}
```

---

## Response Formats

All search tools support three output formats via the `format` parameter:

| Format | Description |
|--------|-------------|
| `concise` | Token-Optimized Object Notation (TOON). Saves 30-60% on LLM context. Best for agent consumption. |
| `standard` | Structured text with confidence bands (HIGH/MED/LOW). Default. Human-readable. |
| `detailed` | Full JSON with all metadata. Best for programmatic consumers. |

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `STRATA_DATA_DIR` | Database and data directory | `~/.strata/` |
| `STRATA_LICENSE_KEY` | Pro/Team license key | _(free tier)_ |
| `STRATA_DEFAULT_USER` | Default user scope | `default` |
| `PORT` | HTTP server port (for `strata serve`) | `3000` |

---

## Further Reading

- [Claude Code Integration](claude-code.md) -- specific setup for Claude Code
- [Architecture Overview](../architecture.md) -- system design and retrieval pipeline
